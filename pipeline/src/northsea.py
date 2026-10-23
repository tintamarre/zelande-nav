#!/usr/bin/env python3
"""Mer du Nord (hors emprise IENC) : profondeurs EMODnet et balisage OpenStreetMap → GeoJSONSeq pour tippecanoe.

Usage:
    uv run python -I src/northsea.py data/zeeland --cache data/ns -o data/ns-out

Rijkswaterstaat ne publie pas d'IENC pour la mer du Nord, et les cartes marines officielles (NL, BE, UK)
ne sont pas libres. Cette couche INDICATIVE complète la carte au large, là où l'IENC ne dessine rien :
- Terre et mer : trait de côte OpenStreetMap (le DTM seul confondrait polders et estran).
- Ports : le trait de côte OSM ferme l'entrée des ports (Zeebrugge, Ostende…), dont les bassins sont des
  surfaces d'eau OSM ; celles reliées à la mer sont rendues comme eau sans sondes (UNSARE), pas comme terre.
- Profondeurs : EMODnet Bathymetry DTM (CC-BY 4.0, maille ~115 m, référence ≈ LAT, le zéro des cartes).
  Pour rester du côté de la prudence, zones et isobathes sont tracées sur le minimum 3 × 3 de la grille
  (un haut-fond est un peu élargi, jamais lissé), et chaque sonde est la moins profonde de son bloc.
- Balisage, feux, épaves, dispositifs de séparation du trafic… : OpenStreetMap (ODbL), tags « seamark »
  (OpenSeaMap) traduits dans les classes et codes S-57 que l'app sait déjà dessiner.
Sortie : enc.geojsonl (couche enc de l'IENC, propriété src="ns"), soundg.json (sondes [lon, lat, profondeur],
élaguées avec celles de l'IENC par enc2pmtiles --extra), current_points.json (mailles du modèle de courants
lues par seacurrents.py) + meta.json.
Ajoute aussi la limite de la carte officielle (M_COVR) et les noms des villes (PLACE, OSM, sur toute l'emprise).
"""
import argparse
import glob
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

import contourpy
import numpy as np
import pyogrio
import rasterio
import shapely
from numpy.lib.stride_tricks import sliding_window_view
from shapely.geometry import LineString, Point, Polygon, mapping
from shapely.ops import unary_union

# Emprise : de Dunkerque aux abords de Rotterdam, jusqu'aux routes du large
BBOX = (2.0, 51.0, 4.6, 52.3)  # lon min, lat min, lon max, lat max
WCS = ("https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage&CoverageId=emodnet__mean"
       "&format=image/tiff&subset=Lat({1},{3})&subset=Long({0},{2})")
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = "zelande-nav/1.0 (+https://github.com/tintamarre/zelande-nav)"

# Limites des zones de profondeur (m sous le zéro) : toutes les isobathes que l'app peut prendre comme
# contour de sécurité (settings.ts) pour que le contour gras existe aussi au large.
LEVELS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 10, 15, 20, 30, 50]
# Zoom d'apparition des isobathes : principales tôt, intermédiaires (0,5 m) seulement de près
CONTOUR_MINZ = {5: 9, 10: 9, 20: 9, 0: 10, 2: 10, 30: 10, 50: 10}
LAND = -4.0  # au-dessus de 4 m (LAT) : terre (dunes, digues) plutôt qu'estran

OPEN_OPTS = {"UPDATES": "APPLY", "RETURN_PRIMITIVES": "OFF", "RETURN_LINKAGES": "OFF", "LNAM_REFS": "OFF"}


def download(url, path, data=None, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r, open(path + ".part", "wb") as f:
                f.write(r.read())
            os.replace(path + ".part", path)
            return
        except Exception as e:
            print(f"  ! {url[:60]}… : {e} (essai {i + 1}/{tries})", file=sys.stderr)
            time.sleep(10 * (i + 1))
    raise SystemExit(f"téléchargement impossible : {url[:80]}")


def fetch_sources(cache):
    os.makedirs(cache, exist_ok=True)
    dtm, osm, coast, water, places = (os.path.join(cache, n) for n in
                                      ("emodnet.tif", "seamarks.json", "coastline.json", "water.json", "places.json"))
    if not os.path.exists(dtm):
        print("téléchargement EMODnet DTM")
        download(WCS.format(*BBOX), dtm)
    b = f"{BBOX[1]},{BBOX[0]},{BBOX[3]},{BBOX[2]}"
    for path, what, q in (
        (osm, "balisage", f'[out:json][timeout:180];(node["seamark:type"]({b});way["seamark:type"]({b}););out geom;'),
        (coast, "trait de côte", f'[out:json][timeout:180];way["natural"="coastline"]({b});out geom;'),
        # Bassins portuaires, écluses, canaux, rivières : candidats « eau reliée à la mer » (les étangs n'ont pas ces tags)
        (water, "bassins et canaux", f'[out:json][timeout:180];('
         f'wr["natural"="water"]["water"~"^(harbour|lock|canal|river|basin|lagoon|tidal)$"]({b});'
         f'wr["natural"="water"]["tidal"="yes"]({b});wr["natural"="water"]["salt"="yes"]({b}););out geom;'),
        (places, "villes", f'[out:json][timeout:180];node["place"~"^(city|town)$"]({b});out;'),
    ):
        if os.path.exists(path):
            continue
        print(f"téléchargement {what} OpenStreetMap (Overpass)")
        data = urllib.parse.urlencode({"data": q}).encode()
        for url in OVERPASS:
            try:
                download(url, path, data, tries=2)
                with open(path) as f:
                    resp = json.load(f)
                # « remark » : délai ou mémoire dépassés côté Overpass, résultat tronqué (à ne pas garder un mois)
                if resp["elements"] and not resp.get("remark"):
                    break
                print(f"  ! {url[:40]}… : réponse {'tronquée' if resp.get('remark') else 'vide'}", file=sys.stderr)
            except (SystemExit, ValueError, KeyError):
                pass
            if os.path.exists(path):
                os.remove(path)  # réponse vide ou invalide : ne pas la garder en cache
        else:
            raise SystemExit(f"Overpass indisponible ({what})")
    return dtm, osm, coast, water, places


def sea_area(coast_path):
    """Mer = faces délimitées par le trait de côte OSM, du côté eau. Les lignes de côte OSM sont orientées
    terre à gauche, mer à droite : chaque face est classée par des points sondes posés de part et d'autre.
    (Le DTM seul ne suffit pas : polders sous +4 m et lacs profonds, Grevelingen ou Haringvliet, le tromperaient.)"""
    box = shapely.box(*BBOX)
    lines = [LineString([(p["lon"], p["lat"]) for p in e["geometry"]]) for e in json.load(open(coast_path))["elements"]
             if len(e.get("geometry", [])) >= 2]
    merged = list(iter_lines(shapely.line_merge(shapely.MultiLineString(lines), directed=True)))
    coast = unary_union(lines).intersection(box)
    faces = list(shapely.polygonize(list(iter_lines(unary_union([coast, box.boundary])))).geoms)
    water, land = [], []
    eps = 0.0003
    for ln in merged:
        c = np.asarray(ln.coords)
        for (x1, y1), (x2, y2) in zip(c[:-1], c[1:]):
            dx, dy = x2 - x1, y2 - y1
            n = math.hypot(dx, dy)
            if n < 2 * eps:
                continue
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            water.append((mx + dy / n * eps, my - dx / n * eps))  # à droite du sens de la ligne
            land.append((mx - dy / n * eps, my + dx / n * eps))
    wtree, ltree = shapely.STRtree(shapely.points(water)), shapely.STRtree(shapely.points(land))
    sea = []
    for f in faces:
        nw, nl = len(wtree.query(f, predicate="contains")), len(ltree.query(f, predicate="contains"))
        if nw > nl:
            sea.append(f)
    sea = unary_union(sea)
    print(f"trait de côte : {len(lines)} lignes, {len(faces)} faces, mer {sea.area / box.area:.0%} de l'emprise")
    return sea, coast


def osm_polygons(path):
    """Surfaces OSM (chemins fermés et multipolygones « out geom ») → [(tags, polygone)]."""
    out = []
    for e in json.load(open(path))["elements"]:
        tags = e.get("tags", {})
        if e["type"] == "way":
            c = [(p["lon"], p["lat"]) for p in e.get("geometry", []) if p]
            if len(c) >= 4 and c[0] == c[-1]:
                out.append((tags, shapely.make_valid(Polygon(c))))
        elif e["type"] == "relation":
            rings = {"outer": [], "inner": []}
            for m in e.get("members", []):
                c = [(p["lon"], p["lat"]) for p in m.get("geometry", []) if p]
                if m.get("type") == "way" and len(c) >= 2 and m.get("role") in rings:
                    rings[m["role"]].append(LineString(c))
            if not rings["outer"]:
                continue
            outer = unary_union(list(shapely.polygonize(rings["outer"]).geoms))
            inner = unary_union(list(shapely.polygonize(rings["inner"]).geoms)) if rings["inner"] else None
            g = outer.difference(inner) if inner is not None else outer
            if not g.is_empty:
                out.append((tags, shapely.make_valid(g)))
    return out


def harbour_water(water_path, sea, outside, hops=4):
    """Bassins, écluses et canaux reliés à la mer (de proche en proche, ~40 m de tolérance pour les portes
    d'écluse et les jointures imprécises), hors mer et hors emprise IENC. Pas de profondeur : EMODnet ne
    couvre pas les bassins (il y donne des cotes de terre)."""
    cands = [(t, g) for t, g in osm_polygons(water_path) if not g.is_empty]
    tree = shapely.STRtree([g for _, g in cands])
    frontier, kept = sea, set()
    for _ in range(hops):
        hit = {int(i) for i in tree.query(frontier.buffer(0.0005), predicate="intersects")} - kept
        if not hit:
            break
        kept |= hit
        frontier = unary_union([cands[i][1] for i in hit])
    feats = []
    for i in sorted(kept):
        tags, g = cands[i]
        g = g.difference(sea).intersection(outside).simplify(0.00005)
        for q in iter_polys(g):
            if q.area > 2e-8:  # ~150 m² : pas les liserés le long du trait de côte
                p = {"objl": "UNSARE"}
                if tags.get("name"):
                    p["OBJNAM"] = tags["name"]
                feats.append(("enc", p, q, 0))
    print(f"ports et canaux : {len(kept)} surfaces d'eau OSM reliées à la mer, {len(feats)} polygones")
    return feats, unary_union([f[2] for f in feats]) if feats else Polygon()


def coverage_edge(cov, water):
    """Limite de la carte officielle, là où elle borde de l'eau de la couche indicative."""
    edge = cov.boundary.intersection(water.buffer(0.0003)).simplify(0.0001)
    return [("enc", {"objl": "M_COVR"}, ln, 0) for ln in iter_lines(edge) if ln.length > 0.002]


def place_features(places_path):
    """Villes (place=city, dès le zoom 7) et villes moyennes (place=town, dès le zoom 10), sur toute l'emprise :
    repères pour s'orienter, classés par population pour que les plus grandes l'emportent en cas de collision."""
    feats = []
    for e in json.load(open(places_path))["elements"]:
        tags = e.get("tags", {})
        name = tags.get("name")  # nom local, celui des panneaux et des cartes
        if e["type"] != "node" or not name:
            continue
        city = tags.get("place") == "city"
        pop = int(re.sub(r"\D", "", (tags.get("population") or "").split(";")[0]) or 0)  # « 11 500 », « 11.500 »
        feats.append(("enc", {"objl": "PLACE", "OBJNAM": name, "rank": 1 if city else 2, "pop": pop},
                      Point(e["lon"], e["lat"]), 7 if city else 10))
    print(f"villes : {len(feats)}")
    return feats


def ienc_coverage(cells_dir):
    """Surface réellement dessinée par l'IENC (terre + eau) : la mer du Nord ne la recouvre jamais."""
    polys = []
    for c in sorted(glob.glob(os.path.join(cells_dir, "**", "*.000"), recursive=True)):
        layers = {n for n, _ in pyogrio.list_layers(c)}
        for layer in ("DEPARE", "DRGARE", "LNDARE", "UNSARE"):
            if layer in layers:
                df = pyogrio.read_dataframe(c, layer=layer, **OPEN_OPTS)
                polys += [shapely.make_valid(g) for g in df.geometry.force_2d() if g is not None and g.geom_type in ("Polygon", "MultiPolygon")]
    if not polys:
        raise SystemExit("aucune zone IENC lue : vérifier le dossier des cellules")
    cov = unary_union([p.buffer(0.00002) for p in polys]).buffer(0)
    print(f"emprise IENC : {len(polys)} polygones")
    return cov


def polygons_from_filled(filled):
    """contourpy FillType.OuterOffset → polygones shapely (avec trous)."""
    out = []
    points, offsets = filled
    for pts, offs in zip(points, offsets):
        rings = [pts[offs[i]:offs[i + 1]] for i in range(len(offs) - 1)]
        rings = [r for r in rings if len(r) >= 4]
        if rings:
            p = shapely.make_valid(Polygon(rings[0], rings[1:]))
            if not p.is_empty:
                out.append(p)
    return out


def iter_polys(g):
    if g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    if hasattr(g, "geoms"):
        return [p for x in g.geoms for p in iter_polys(x)]
    return []


def iter_lines(g):
    if g.is_empty:
        return []
    if g.geom_type == "LineString":
        return [g]
    if hasattr(g, "geoms"):
        return [p for x in g.geoms for p in iter_lines(x)]
    return []


def bathymetry(dtm_path, outside):
    with rasterio.open(dtm_path) as r:
        elev = r.read(1).astype("float64")
        t = r.transform
    depth = -elev
    depth[~np.isfinite(depth)] = np.nan
    ny, nx = depth.shape
    lon = t.c + t.a * (np.arange(nx) + 0.5)
    lat = t.f + t.e * (np.arange(ny) + 0.5)
    # minimum 3 × 3 : prudence (les hauts-fonds s'élargissent d'une maille, ne disparaissent jamais)
    pad = np.pad(depth, 1, mode="edge")
    shoal = np.nanmin(sliding_window_view(pad, (3, 3)), axis=(2, 3))
    gen = contourpy.contour_generator(lon, lat, shoal, fill_type="OuterOffset", line_type="Separate", quad_as_tri=False)
    feats = []
    bounds = [-1000.0, LAND] + LEVELS + [1000.0]
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        for p in polygons_from_filled(gen.filled(lo, hi)):
            g = p.intersection(outside).simplify(0.0002)
            for q in iter_polys(g):
                if q.area < 1e-8:
                    continue
                if hi <= LAND:
                    feats.append(("enc", {"objl": "LNDARE"}, q, 0))
                else:
                    d1, d2 = (LAND, 0) if hi <= 0 else (lo, hi)
                    feats.append(("enc", {"objl": "DEPARE", "DRVAL1": d1, "DRVAL2": d2 if hi < 1000 else None}, q, 0))
    for v in LEVELS:
        for seg in gen.lines(v):
            if len(seg) < 2:
                continue
            ln0 = LineString(seg)
            if ln0.length < 0.004 and ln0.is_ring:  # anneau de moins de ~300 m : bruit de la grille
                continue
            g = ln0.intersection(outside).simplify(0.0002)
            for ln in iter_lines(g):
                feats.append(("enc", {"objl": "DEPCNT", "VALDCO": v}, ln, CONTOUR_MINZ.get(v, 12)))
    # Sondes : la moins profonde de chaque bloc de 4 × 4 mailles (~460 m), en eau ou sur l'estran
    k = 4
    sound = []
    for i in range(0, ny - k + 1, k):
        for j in range(0, nx - k + 1, k):
            blk = depth[i:i + k, j:j + k]
            if np.all(np.isnan(blk)):
                continue
            a, b = np.unravel_index(np.nanargmin(blk), blk.shape)
            d = blk[a, b]
            if d < LAND:
                continue
            x, y = float(lon[j + b]), float(lat[i + a])
            if not outside.contains(Point(x, y)):
                continue
            sound.append((x, y, math.floor(d * 10) / 10))  # arrondi vers le moins profond
    print(f"bathymétrie : {len(feats)} zones et isobathes, {len(sound)} sondes")
    return feats, sound


# ---------- balisage OpenStreetMap (tags OpenSeaMap, dérivés de S-57) ----------
TYPE2OBJL = {
    "buoy_lateral": "BOYLAT", "buoy_cardinal": "BOYCAR", "buoy_isolated_danger": "BOYISD",
    "buoy_safe_water": "BOYSAW", "buoy_special_purpose": "BOYSPP",
    "beacon_lateral": "BCNLAT", "beacon_cardinal": "BCNCAR", "beacon_isolated_danger": "BCNISD",
    "beacon_safe_water": "BCNSAW", "beacon_special_purpose": "BCNSPP",
    "light_major": "LIGHTS", "light_minor": "LIGHTS", "light": "LIGHTS", "light_vessel": "LIGHTS", "light_float": "LIGHTS",
    "wreck": "WRECKS", "obstruction": "OBSTRN", "rock": "UWTROC", "pile": "PILPNT", "platform": "OFSPLF",
    "separation_zone": "TSEZNE", "separation_boundary": "TSSBND", "separation_line": "TSSBND",
    "separation_lane": "TSSLPT", "separation_roundabout": "TSEZNE",
    "restricted_area": "RESARE", "anchorage": "ACHARE", "anchor_berth": "ACHARE", "precautionary_area": "PRCARE",
    "cable_submarine": "CBLSUB", "pipeline_submarine": "PIPSOL", "cable_area": "CBLARE", "pipeline_area": "PIPARE",
    "marine_farm": "MARCUL", "dumping_ground": "DMPGRD", "fairway": "FAIRWY",
    "navigation_line": "NAVLNE", "recommended_track": "RECTRC", "ferry_route": "FERYRT",
    "harbour": "HRBFAC", "small_craft_facility": "SMCFAC", "pilot_boarding": "PILBOP", "radar_transponder": "RTPBCN",
    "fog_signal": "FOGSIG", "rescue_station": "RSCSTA", "coastguard_station": "CGUSTA",
}
COLOUR = {"white": 1, "black": 2, "red": 3, "green": 4, "blue": 5, "yellow": 6, "grey": 7, "brown": 8,
          "amber": 9, "violet": 10, "orange": 11, "magenta": 12, "pink": 13}
COLPAT = {"horizontal": 1, "vertical": 2, "diagonal": 3, "squared": 4, "stripes": 5, "border": 6}
BOYSHP = {"conical": 1, "can": 2, "spherical": 3, "sphere": 3, "pillar": 4, "spar": 5, "barrel": 6, "super-buoy": 7, "ice_buoy": 8}
BCNSHP = {"stake": 1, "pole": 1, "perch": 1, "post": 1, "withy": 2, "tower": 3, "lattice": 4, "pile": 5, "cairn": 6, "buoyant": 7}
CATLAM = {"port": 1, "starboard": 2, "preferred_channel_starboard": 3, "preferred_channel_port": 4}
CATCAM = {"north": 1, "east": 2, "south": 3, "west": 4}
TOPSHP = {"cone, point up": 1, "cone, point down": 2, "sphere": 3, "2 spheres": 4, "cylinder": 5, "board": 6,
          "x-shape": 7, "cross": 8, "cube, point up": 9, "2 cones point together": 10, "2 cones base together": 11,
          "rhombus": 12, "2 cones up": 13, "2 cones down": 14, "besom, point up": 15, "besom, point down": 16,
          "flag": 17, "sphere over rhombus": 18, "square": 19, "rectangle, horizontal": 20, "rectangle, vertical": 21,
          "trapezium, up": 22, "trapezium, down": 23, "triangle, point up": 24, "triangle, point down": 25,
          "circle": 26, "2 upright crosses": 27, "t-shape": 28, "triangle, point up over circle": 29,
          "upright cross over circle": 30, "rhombus over circle": 31, "circle over triangle, point up": 32, "other": 33}
LITCHR = {"F": 1, "Fl": 2, "LFl": 3, "Q": 4, "VQ": 5, "UQ": 6, "Iso": 7, "Oc": 8, "IQ": 9, "IVQ": 10, "IUQ": 11,
          "Mo": 12, "FFl": 13, "FlLFl": 14, "OcFl": 15, "FLFl": 16, "Al.Oc": 17, "Al.LFl": 18, "Al.Fl": 19,
          "Al.Gr": 20, "Q+LFl": 25, "VQ+LFl": 26, "UQ+LFl": 27, "Al": 28, "Al.FFl": 29}
CATWRK = {"non-dangerous": 1, "dangerous": 2, "distributed_remains": 3, "mast_showing": 4, "hull_showing": 5}
WATLEV = {"partly-submerged": 1, "dry": 2, "submerged": 3, "covers": 4, "awash": 5, "floods": 6, "floating": 7}


def codes(value, table):
    """« red;white » → « 3,1 » (même forme que les listes S-57 écrites par enc2pmtiles)."""
    out = [str(table[v.strip()]) for v in (value or "").split(";") if v.strip() in table]
    return ",".join(out) or None


def num(v):
    try:
        return float(str(v).split(";")[0].replace(",", ".").strip().split(" ")[0])
    except (ValueError, AttributeError):
        return None


def seamark_features(osm_path, outside, prep_sea):
    elements = json.load(open(osm_path))["elements"]
    feats = []
    for e in elements:
        tags = e.get("tags", {})
        st = tags.get("seamark:type", "")
        if st == "landmark" and "windmotor" in tags.get("seamark:landmark:category", ""):
            objl = "OFSPLF"  # éolienne en mer
        else:
            objl = TYPE2OBJL.get(st)
        if not objl:
            continue
        # géométrie
        if e["type"] == "node":
            geom = Point(e["lon"], e["lat"])
            if not prep_sea.contains(geom):
                continue  # dans l'emprise IENC (la carte officielle prime) ou en eaux intérieures
        else:
            coords = [(p["lon"], p["lat"]) for p in e.get("geometry", []) if p]
            if len(coords) < 2:
                continue
            closed = coords[0] == coords[-1] and len(coords) >= 4
            area_cls = objl in {"TSEZNE", "RESARE", "ACHARE", "PRCARE", "CBLARE", "PIPARE", "MARCUL", "DMPGRD", "FAIRWY", "TSSLPT", "HRBFAC", "SMCFAC"}
            geom = shapely.make_valid(Polygon(coords)) if closed and area_cls else LineString(coords)
            geom = geom.intersection(outside)
            if geom.is_empty:
                continue
            if objl in ("HRBFAC", "SMCFAC"):
                geom = geom.representative_point()
        p = {"objl": objl}
        name = tags.get("seamark:name") or tags.get("name")
        if name:
            p["OBJNAM"] = name
        pre = f"seamark:{st}:"
        g = lambda k: tags.get(pre + k)  # noqa: E731
        if objl.startswith(("BOY", "BCN")):
            p["COLOUR"] = codes(g("colour"), COLOUR)
            p["COLPAT"] = codes(g("colour_pattern"), COLPAT)
            if objl.startswith("BOY"):
                p["BOYSHP"] = BOYSHP.get(g("shape") or "")
            else:
                p["BCNSHP"] = BCNSHP.get(g("shape") or "")
            if objl.endswith("LAT"):
                p["CATLAM"] = CATLAM.get(g("category") or "")
            if objl.endswith("CAR"):
                p["CATCAM"] = CATCAM.get(g("category") or "")
        elif objl == "WRECKS":
            p["CATWRK"] = CATWRK.get(g("category") or "")
        if objl in ("WRECKS", "OBSTRN", "UWTROC"):
            p["VALSOU"] = num(tags.get(pre + "depth") or tags.get("seamark:depth"))
            p["WATLEV"] = WATLEV.get(g("water_level") or "")
        if objl in ("RESARE", "ACHARE"):
            p["INFORM"] = g("restriction") or g("category")
        n_lights = 0
        # Voyant et feu portés par la marque (objets séparés en S-57)
        if e["type"] == "node":
            top = tags.get("seamark:topmark:shape")
            if top in TOPSHP:
                feats.append(("enc", {"objl": "TOPMAR", "TOPSHP": TOPSHP[top], "COLOUR": codes(tags.get("seamark:topmark:colour"), COLOUR)}, geom, 12))
            lights = sorted({k.split(":")[2] for k in tags if k.startswith("seamark:light:") and k.split(":")[2].isdigit()}) or [None]
            for n in lights:
                lp = "seamark:light:" + (f"{n}:" if n else "")
                if not (tags.get(lp + "character") or tags.get(lp + "colour")):
                    continue
                lt = {"objl": "LIGHTS", "COLOUR": codes(tags.get(lp + "colour"), COLOUR),
                      "LITCHR": LITCHR.get((tags.get(lp + "character") or "").strip()),
                      "SIGGRP": f"({tags[lp + 'group']})" if tags.get(lp + "group") else None,
                      "SIGPER": num(tags.get(lp + "period")), "VALNMR": num(tags.get(lp + "range")),
                      "HEIGHT": num(tags.get(lp + "height")),
                      "SECTR1": num(tags.get(lp + "sector_start")), "SECTR2": num(tags.get(lp + "sector_end"))}
                if name:
                    lt["OBJNAM"] = name
                feats.append(("enc", lt, geom, 9))
                n_lights += 1
        # Feu seul (light_minor…) déjà décrit par ses tags seamark:light:* : pas d'objet LIGHTS vide en double
        if not (objl == "LIGHTS" and n_lights):
            feats.append(("enc", p, geom, 9 if objl.startswith(("BOY", "BCN", "LIGHTS", "WRECKS", "OBSTRN")) else 8))
    print(f"balisage OSM : {len(feats)} objets hors emprise IENC")
    return feats


def current_points(outside_sea):
    """Mailles du modèle de courants SMOC (Mercator, 1/12°, centres en k/12 + 1/24) en mer du Nord, hors carte
    officielle et à plus de ~1 km de la côte (le modèle n'y résout ni les chenaux ni les bancs).
    seacurrents.py y lit chaque jour la prévision (Open-Meteo) ; en Zélande, l'estimation de currents.py prime."""
    inner = outside_sea.buffer(-0.012)
    lats = np.arange(BBOX[1] + 1 / 24, BBOX[3], 1 / 12)
    lons = np.arange(BBOX[0] + 1 / 24, BBOX[2], 1 / 12)
    lon, lat = np.meshgrid(lons, lats)
    keep = shapely.contains_xy(inner, lon, lat)
    pts = [[round(float(y), 4), round(float(x), 4)] for x, y in zip(lon[keep], lat[keep])]
    print(f"courants mer du Nord : {len(pts)} mailles du modèle")
    return pts


def write(feats, sound, out, cur_points):
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "enc.geojsonl"), "w") as f:
        for layer, props, geom, minz in feats:
            props = {k: v for k, v in props.items() if v is not None}
            props |= {"src": "ns", "minz": minz}
            f.write(json.dumps({"type": "Feature", "tippecanoe": {"layer": layer, "minzoom": minz},
                                "properties": props, "geometry": mapping(geom)}, separators=(",", ":")) + "\n")
    # minzoom des sondes : même élagage que l'IENC (la moins profonde par maille), fait par enc2pmtiles
    with open(os.path.join(out, "soundg.json"), "w") as f:
        json.dump(sound, f, separators=(",", ":"))
    with open(os.path.join(out, "current_points.json"), "w") as f:
        json.dump(cur_points, f, separators=(",", ":"))
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump({"bounds": list(BBOX), "sources": "EMODnet Bathymetry (CC-BY 4.0), © OpenStreetMap (ODbL)"}, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cells_dir", help="cellules IENC (pour ne pas recouvrir la carte officielle)")
    ap.add_argument("--cache", default="data/ns", help="dossier des téléchargements bruts (gardés d'une exécution à l'autre)")
    ap.add_argument("-o", "--output", required=True)
    a = ap.parse_args()
    dtm, osm, coast_path, water_path, places_path = fetch_sources(a.cache)
    cov = ienc_coverage(a.cells_dir)
    sea, coast = sea_area(coast_path)
    outside = shapely.box(*BBOX).difference(cov)
    outside_sea = outside.intersection(sea)
    shapely.prepare(outside)
    shapely.prepare(outside_sea)
    feats, sound = bathymetry(dtm, outside_sea)
    # Ports et canaux reliés à la mer (eau sans sondes) ; le reste du côté terre du trait de côte est de la terre
    harbour, harbour_area = harbour_water(water_path, sea, outside)
    feats += harbour
    for q in iter_polys(outside.difference(sea).difference(harbour_area).simplify(0.0002)):
        if q.area > 1e-8:
            feats.append(("enc", {"objl": "LNDARE"}, q, 0))
    for ln in iter_lines(coast.intersection(outside)):
        feats.append(("enc", {"objl": "COALNE"}, ln, 0))
    water = unary_union([outside_sea, harbour_area])
    feats += coverage_edge(cov, water)
    # Balisage : en mer et dans les ports (marge de ~50 m pour les balises posées sur la laisse ou un quai)
    sea_margin = water.buffer(0.0007).intersection(outside)
    feats += seamark_features(osm, sea_margin, shapely.prepared.prep(sea_margin))
    feats += place_features(places_path)
    if len(sound) < 1000 or sum(1 for f in feats if f[1]["objl"] == "DEPARE") < 50:
        sys.exit("mer du Nord : trop peu d'objets, vérifier les téléchargements")
    write(feats, sound, a.output, current_points(outside_sea))


if __name__ == "__main__":
    main()
