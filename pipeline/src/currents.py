#!/usr/bin/env python3
"""Grille de courants de marée ESTIMÉS (type atlas de courants) à partir de la carte et des marées officielles.

Usage:
    uv run python -I src/currents.py data/zeeland --tides ../public/tiles/tides.json -o ../public/tiles/currents.json

Méthode (indicative, pas un modèle hydrodynamique) :
- Eaux à marée : zones de profondeur (DEPARE/DRGARE) reliées à la mer sans passer par un ouvrage
  (sas « lokbsn », portes et vannes « GATCON », barrages « DAMCON » retirés avant de chercher les
  composantes connexes). Le Veerse Meer, le
  Grevelingen, le Volkerak-Zoommeer et les canaux sont ainsi exclus sans contour tracé à la main.
- Grille d'environ 900 m ; profondeur au point = DRVAL1 de la zone qui le contient (estrans exclus).
- Direction du flot : axe de la voie navigable la plus proche (IENC « wtwaxs », < 2 km), orienté vers
  l'amont de l'estuaire ; l'amont est donné par une « ligne d'estuaire » tracée par bassin, de la mer
  vers l'intérieur (Westerschelde jusqu'à Bath, deux branches de l'Oosterschelde, côte vers le nord-est,
  sens de propagation de la marée le long de la côte néerlandaise). Hors axe : la direction de cette ligne.
- Vitesse maximale à marée moyenne : valeur par bassin (ordre de grandeur des atlas publiés),
  modulée par la profondeur, réduite hors des chenaux et très réduite dans les bassins portuaires. L'app module ensuite par le marnage du jour et le cycle flot/jusant.
- Chaque point est rattaché aux deux stations de marée les plus proches de son bassin (pondération
  inverse de la distance) : l'app y lit les heures de pleine et basse mer.
"""
import argparse
import glob
import json
import math
import os
import sys

import numpy as np
import pyogrio
import shapely
from shapely.geometry import Point
from shapely.ops import unary_union

OPEN_OPTS = {"UPDATES": "APPLY", "RETURN_PRIMITIVES": "OFF", "RETURN_LINKAGES": "OFF", "LNAM_REFS": "OFF"}

GROUPS = {
    "westerschelde": ["westkapelle", "vlissingen", "terneuzen", "hansweert"],
    "oosterschelde": ["oosterschelde.roompotsluis.buiten", "stavenisse", "yerseke", "krammersluizen.west"],
    "kust": ["westkapelle", "oosterschelde.roompotsluis.buiten"],
}
# Lignes d'estuaire (lon, lat), de la mer vers l'amont : le flot porte dans ce sens
SPINES = {
    "westerschelde": [[(3.25, 51.39), (3.45, 51.41), (3.60, 51.43), (3.72, 51.41), (3.84, 51.37), (3.93, 51.39),
                       (4.00, 51.43), (4.08, 51.42), (4.17, 51.39), (4.25, 51.36)]],
    "oosterschelde": [[(3.62, 51.63), (3.69, 51.62), (3.80, 51.61), (3.90, 51.60), (3.98, 51.57), (4.05, 51.53),
                       (4.10, 51.49), (4.17, 51.46)],                                   # branche sud (Yerseke, Kreekrak)
                      [(3.90, 51.60), (3.98, 51.62), (4.04, 51.65), (4.10, 51.66), (4.17, 51.67)]],  # branche nord (Krammer)
    "kust": [[(3.20, 51.33), (3.38, 51.52), (3.58, 51.68), (3.80, 51.80), (4.00, 51.90)]],
}
# Points dont on est sûr qu'ils sont en eaux à marée (pour choisir les composantes connexes)
SEEDS = [(3.30, 51.60), (3.60, 51.42), (3.95, 51.43), (3.69, 51.63), (3.95, 51.60), (4.10, 51.62)]


def basin(lat, lon):
    if lat < 51.475:
        return "westerschelde"
    # Oosterschelde : à l'est de la kering, au sud de Schouwen-Duiveland (le nord de Schouwen est la côte)
    if lon >= 3.68 and (lat < 51.64 or (lon > 3.95 and lat < 51.70)):
        return "oosterschelde"
    return "kust"


def upstream_bearing(lat, lon, b):
    """Direction (°) de la ligne d'estuaire au point le plus proche, orientée mer → amont."""
    best = None
    for spine in SPINES[b]:
        line = shapely.LineString(spine)
        d = line.distance(Point(lon, lat))
        if best is None or d < best[0]:
            best = (d, line)
    line = best[1]
    s = line.project(Point(lon, lat))
    q1, q2 = line.interpolate(max(0.0, s - 0.01)), line.interpolate(min(line.length, s + 0.01))
    return bearing(q1.x, q1.y, q2.x, q2.y)


def vmax_mean(lat, lon, b):
    """Courant maximal en chenal à marée moyenne (nœuds) — ordre de grandeur."""
    if b == "westerschelde":
        return 2.2
    if b == "kust":
        return 1.3
    # Oosterschelde : fort près de la kering, décroissant vers l'est
    return float(np.interp(lon, [3.68, 3.76, 3.85, 4.0, 4.15], [2.6, 2.4, 1.8, 1.2, 0.9]))


def read_layer(cells, layer):
    geoms, attrs = [], []
    for c in cells:
        if layer not in [n for n, _ in pyogrio.list_layers(c)]:
            continue
        df = pyogrio.read_dataframe(c, layer=layer, **OPEN_OPTS)
        df = df[df.geometry.notna()]
        geoms += list(df.geometry.force_2d())
        attrs += df.drop(columns="geometry").to_dict("records")
    return geoms, attrs


def bearing(lon1, lat1, lon2, lat2):
    y = math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2))
    x = math.cos(math.radians(lat1)) * math.sin(math.radians(lat2)) - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(math.radians(lon2 - lon1))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cells_dir")
    ap.add_argument("--tides", required=True)
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--step", type=float, default=0.008, help="pas en latitude (°) ; longitude × 1,5")
    a = ap.parse_args()

    with open(a.tides) as f:
        tides = json.load(f)["stations"]
    pos = {code: (st["lat"], st["lon"]) for code, st in tides.items()}
    groups = {b: [c for c in st if c in pos] or list(pos) for b, st in GROUPS.items()}  # station absente : repli
    print("stations de marée :", ", ".join(pos))

    cells = sorted(glob.glob(os.path.join(a.cells_dir, "**", "*.000"), recursive=True))
    dep, dep_attr = [], []
    for layer in ("DEPARE", "DRGARE"):
        g, at = read_layer(cells, layer)
        dep += g
        dep_attr += at
    # Ouvrages qui séparent des eaux sans marée : sas, portes d'écluse/vannes, barrages
    locks = []
    for layer in ("lokbsn", "GATCON", "DAMCON"):
        locks += read_layer(cells, layer)[0]
    axes, _ = read_layer(cells, "wtwaxs")
    # Bassins portuaires : courant très réduit (abrités, en cul-de-sac)
    harbours = [g for layer in ("hrbare", "hrbbsn") for g in read_layer(cells, layer)[0] if g.geom_type in ("Polygon", "MultiPolygon")]
    harbour_prep = shapely.prepared.prep(unary_union(harbours)) if harbours else None
    print(f"{len(dep)} zones de profondeur, {len(locks)} ouvrages (sas, portes, barrages), {len(axes)} axes de voie navigable")

    # Eaux à marée : composantes connexes reliées à la mer, sas retirés
    polys = [g for g in dep if g.geom_type in ("Polygon", "MultiPolygon")]
    water = unary_union([shapely.make_valid(g).buffer(0.00002) for g in polys])  # ~2 m pour souder les cellules
    if locks:
        water = water.difference(unary_union([g.buffer(0.0003) for g in locks]))  # ~30 m autour des ouvrages
    comps = list(water.geoms) if hasattr(water, "geoms") else [water]
    tidal = unary_union([c for c in comps if any(c.contains(Point(x, y)) for x, y in SEEDS)])
    print(f"{len(comps)} composantes d'eau, dont {sum(1 for c in comps if any(c.contains(Point(x, y)) for x, y in SEEDS))} à marée")

    tree = shapely.STRtree(polys)
    poly_attr = [at for g, at in zip(dep, dep_attr) if g.geom_type in ("Polygon", "MultiPolygon")]
    ax_tree = shapely.STRtree(axes) if axes else None
    tidal_prep = shapely.prepared.prep(tidal)

    pts = []
    minx, miny, maxx, maxy = tidal.bounds
    for lat in np.arange(miny, maxy, a.step):
        for lon in np.arange(minx, maxx, a.step * 1.5):
            p = Point(lon, lat)
            if not tidal_prep.contains(p):
                continue
            depths = [poly_attr[i].get("DRVAL1") for i in tree.query(p, predicate="within")]
            depths = [d for d in depths if d is not None and not math.isnan(d)]
            if not depths or max(depths) < 0:  # estran : pas de flèche
                continue
            d = max(depths)
            b = basin(lat, lon)
            prop = upstream_bearing(lat, lon, b)  # vers l'amont : sens du flot
            flood, on_axis = prop, False
            if ax_tree is not None:
                i = ax_tree.nearest(p)
                ax = axes[i]
                if ax.distance(p) < 0.02:  # ~2 km
                    s = shapely.line_locate_point(ax, p)
                    q1, q2 = ax.interpolate(max(0, s - 0.002)), ax.interpolate(min(ax.length, s + 0.002))
                    if q1.distance(q2) > 0:
                        brg = bearing(q1.x, q1.y, q2.x, q2.y)
                        flood = brg if math.cos(math.radians(brg - prop)) >= 0 else (brg + 180) % 360
                        on_axis = True
            v = vmax_mean(lat, lon, b) * min(1.15, max(0.35, math.sqrt(max(d, 0.5) / 10))) * (1 if on_axis else 0.7)
            if harbour_prep is not None and harbour_prep.contains(p):
                v *= 0.25
            # deux stations les plus proches du bassin, poids inverse de la distance
            k = math.cos(math.radians(lat))
            st = sorted((((lat - pos[s][0]) ** 2 + ((lon - pos[s][1]) * k) ** 2, s) for s in groups[b]))[:2]
            w1 = 1.0 if len(st) == 1 or st[0][0] == 0 else (1 / st[0][0]) / (1 / st[0][0] + 1 / st[1][0])
            pts.append([round(lat, 4), round(lon, 4), round(flood), round(v, 2), st[0][1], st[-1][1], round(w1, 2)])
    if len(pts) < 100:
        sys.exit(f"trop peu de points de courant ({len(pts)}) : vérifier les données")
    with open(a.output, "w") as f:
        json.dump({"note": "Courants de marée estimés (indicatif)", "fields": ["lat", "lon", "flot_deg", "vmax_kn", "station1", "station2", "poids1"], "points": pts}, f, separators=(",", ":"))
    print(f"{len(pts)} points de courant → {a.output} ({os.path.getsize(a.output) / 1000:.0f} Ko)")


if __name__ == "__main__":
    main()
