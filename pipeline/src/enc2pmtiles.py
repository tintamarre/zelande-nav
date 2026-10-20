#!/usr/bin/env python3
"""Convertit des cellules S-57 (ENC / Inland ENC) en un fichier PMTiles unique.

Usage:
    uv run python -I src/enc2pmtiles.py data/zeeland -o tiles/zeeland.pmtiles [--meta data/zeeland.json]

Dépendances : pyogrio (GDAL embarqué, lit le S-57 et applique les mises à jour .001…)
et tippecanoe >= 2.17 dans le PATH (génère directement du PMTiles).

Choix de conception :
- Deux couches vectorielles : "enc" (tout sauf les sondes, classe S-57 dans "objl")
  et "soundg" (sondes, profondeur dans "depth" ; négative = hauteur découvrante).
- Minzoom par objet : dérivé de SCAMIN quand il existe, sinon de la classe.
- Sondes : élagage par grille imbriquée ; à chaque zoom, la sonde la moins profonde
  de chaque maille est retenue (comme une carte papier, qui privilégie les hauts-fonds).
- GDAL n'écrit pas de PMTiles multi-couches depuis pyogrio et ne gère pas de minzoom
  par objet : d'où le passage par tippecanoe (434 000 sondes sur la Zélande).
"""
import argparse
import glob
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio
from shapely.geometry import mapping

# Classes utiles à la navigation de plaisance (sous-ensemble S-57 / Inland ENC).
# Les classes IENC sont en minuscules dans GDAL (bridge, wtwaxs…).
KEEP = {
    # fond de carte
    "LNDARE", "COALNE", "DEPARE", "DEPCNT", "DRGARE", "UNSARE", "SLCONS", "BUAARE",
    "LAKARE", "CANALS", "RIVERS", "SEAARE", "LNDRGN", "DYKCON", "LNDMRK",
    "BRIDGE", "bridge", "PONTON", "CAUSWY", "DAMCON", "GATCON", "DRYDOC", "FLODOC",
    "lokbsn", "TUNNEL", "PYLONS", "CBLOHD", "cblohd",
    # chenaux et règles
    "FAIRWY", "NAVLNE", "RECTRC", "TSSLPT", "TSSBND", "TSEZNE", "RESARE", "resare",
    "ACHARE", "achare", "achbrt", "PRCARE", "CTNARE", "MIPARE", "SPLARE", "FERYRT",
    "MARCUL", "CBLSUB", "CBLARE", "PIPSOL", "PIPARE", "DMPGRD",
    # balisage
    "BOYLAT", "BOYCAR", "BOYISD", "BOYSAW", "BOYSPP", "BCNLAT", "BCNCAR", "BCNISD",
    "BCNSAW", "BCNSPP", "LIGHTS", "TOPMAR", "DAYMAR", "FOGSIG", "RTPBCN", "RADRFL",
    # dangers
    "WRECKS", "OBSTRN", "UWTROC", "PILPNT",
    # installations
    "HRBFAC", "hrbfac", "SMCFAC", "BERTHS", "berths", "MORFAC", "OFSPLF", "hrbare",
    "hrbbsn", "termnl", "bunsta", "CGUSTA", "RSCSTA", "PILBOP",
    # Inland ENC (extensions)
    "wtwaxs", "wtwprf", "notmrk", "comare", "trnbsn", "rdocal", "RDOCAL", "lokare",
    "exceed", "sistat", "sistaw", "dismar", "lkbspt",
}

# Attributs conservés (le reste alourdit les tuiles sans servir au rendu ni au popup).
ATTRS = [
    "OBJNAM", "NOBJNM", "INFORM", "NINFOM",
    "DRVAL1", "DRVAL2", "VALDCO", "VALSOU", "EXPSOU", "QUASOU", "WATLEV",
    "CATLAM", "CATCAM", "CATSPM", "BOYSHP", "BCNSHP", "TOPSHP", "COLOUR", "COLPAT",
    "CATLIT", "LITCHR", "SIGGRP", "SIGPER", "VALNMR", "HEIGHT", "ORIENT", "SECTR1",
    "SECTR2", "EXCLIT", "PERSTA", "PEREND", "DATSTA", "DATEND",
    "CATWRK", "CATOBS", "CATREA", "CATSLC", "CATSEA", "RESTRN", "CATMFA",
    "VERCLR", "VERCCL", "VERCOP", "HORCLR", "HORLEN", "HORWID", "catbrg",
    "horcll", "horclw", "catnmk", "fnctnm", "dirimp", "addmrk", "cathaf", "catbrt",
    "catsiw", "catdis", "wtwdis", "STATUS",
]

OPEN_OPTS = {
    "SPLIT_MULTIPOINT": "ON",
    "ADD_SOUNDG_DEPTH": "ON",
    "UPDATES": "APPLY",          # applique .001, .002... si présents à côté du .000
    "LNAM_REFS": "OFF",
    "RETURN_PRIMITIVES": "OFF",
    "RETURN_LINKAGES": "OFF",
}

# Minzoom par défaut quand SCAMIN est absent (zoom MapLibre, tuiles 512 px).
CLASS_MINZOOM = {
    "SOUNDG": 12, "DEPCNT": 10, "TOPMAR": 13, "DAYMAR": 13, "FOGSIG": 13,
    "dismar": 14, "berths": 14, "BERTHS": 14, "MORFAC": 14, "PILPNT": 14,
    "notmrk": 13, "LNDMRK": 12, "BUAARE": 9, "rdocal": 13, "RDOCAL": 13,
    "CBLSUB": 12, "PIPSOL": 12, "sistaw": 13, "sistat": 13,
}

# Échelle MapLibre au zoom 0 (tuiles 512 px, pixel 0,28 mm) à la latitude de la Zélande.
SCALE_Z0 = 279_541_132 * math.cos(math.radians(51.5))


def scamin_to_zoom(scamin):
    """Zoom à partir duquel l'objet doit apparaître (1 niveau de marge)."""
    return math.floor(math.log2(SCALE_Z0 / scamin)) - 1


def cell_scale(path):
    try:
        dsid = pyogrio.read_dataframe(path, layer="DSID", read_geometry=False, **OPEN_OPTS)
        return int(dsid.get("DSPM_CSCL", pd.Series([0])).iloc[0] or 0)
    except Exception:
        return 0


def read_cell(path, cscl):
    frames = []
    for layer, _geom in pyogrio.list_layers(path):
        if layer not in KEEP and layer != "SOUNDG":
            continue
        try:
            df = pyogrio.read_dataframe(path, layer=layer, **OPEN_OPTS)
        except Exception as e:  # couche vide ou géométrie non supportée
            print(f"  ! {os.path.basename(path)}:{layer}: {e}", file=sys.stderr)
            continue
        df = df[df.geometry.notna() & ~df.geometry.is_empty]
        if df.empty:
            continue
        keep = [c for c in ATTRS + ["SCAMIN"] if c in df.columns]
        out = df[keep + ["geometry"]].copy()
        out["objl"] = layer
        out["cscl"] = cscl
        out["cell"] = os.path.splitext(os.path.basename(path))[0]
        if layer == "SOUNDG":
            out["depth"] = out.geometry.map(lambda g: round(g.z, 1) if g.has_z else np.nan)
        out = out.set_geometry(out.geometry.force_2d())
        frames.append(out)
    return frames


def thin_soundings(snd, zmin=10, zmax=16, cell_px=48):
    """minzoom par sonde : la moins profonde de chaque maille (grille imbriquée en 2^z)."""
    x = snd.geometry.x.to_numpy()
    y = np.degrees(np.log(np.tan(np.pi / 4 + np.radians(snd.geometry.y.to_numpy()) / 2)))  # Mercator
    depth = snd["depth"].fillna(999).to_numpy()
    minz = np.full(len(snd), zmax, dtype=int)
    for z in range(zmin, zmax):
        size = 360 / (2 ** z) / 512 * cell_px
        key = pd.DataFrame({"i": np.floor(x / size), "j": np.floor(y / size), "d": depth})
        shoalest = key.groupby(["i", "j"])["d"].idxmin().to_numpy()
        sel = np.zeros(len(snd), dtype=bool)
        sel[shoalest] = True
        minz[sel & (minz == zmax)] = z
    return minz


# Isobathes principales visibles dès le zoom 10, les autres (tous les 0,5 m) plus tard.
MAIN_CONTOURS = {-2.0, 0.0, 2.0, 5.0, 10.0, 20.0}


# Fond de carte visible dès le zoom minimum (vue d'ensemble de la Zélande).
BASE_CLASSES = {"DEPARE", "DRGARE", "LNDARE", "COALNE", "UNSARE", "BUAARE", "SLCONS"}


def to_minzoom(scamin, objl, valdco=None, is_point=False):
    base = 0 if objl in BASE_CLASSES else CLASS_MINZOOM.get(objl, 10 if is_point else 8)
    if objl == "DEPCNT" and valdco not in MAIN_CONTOURS:
        base = 12 if valdco is not None and float(valdco).is_integer() else 13
    if pd.notna(scamin) and scamin:
        return max(base, min(16, scamin_to_zoom(float(scamin))))
    return base


def clean_value(v):
    if isinstance(v, (list, tuple, np.ndarray)):
        return ",".join(map(str, v)) if len(v) else None
    if v is None or (isinstance(v, float) and math.isnan(v)) or v == "":
        return None
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.floating):
        return float(v)
    return v


def write_geojsonseq(gdf, path, layer, maxzoom):
    """minz est aussi gardé en propriété : le style filtre dessus au-delà du zoom max des tuiles."""
    props_cols = [c for c in gdf.columns if c not in ("geometry", "SCAMIN", "cscl")]
    with open(path, "w") as f:
        for rec, geom, minz in zip(gdf[props_cols].itertuples(index=False), gdf.geometry, gdf["minz"]):
            props = {k: v for k, v in ((k, clean_value(v)) for k, v in zip(props_cols, rec)) if v is not None}
            f.write(json.dumps({
                "type": "Feature",
                "tippecanoe": {"layer": layer, "minzoom": min(int(minz), maxzoom)},
                "properties": props,
                "geometry": mapping(geom),
            }, separators=(",", ":")) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--meta", help="JSON d'édition produit par fetch_ienc.py (date, titre)")
    ap.add_argument("--minzoom", type=int, default=6)
    ap.add_argument("--maxzoom", type=int, default=15)
    ap.add_argument("--min-bytes", type=int, default=0,
                    help="échoue si le PMTiles est plus petit (garde-fou contre une génération tronquée)")
    ap.add_argument("--keep-geojson", help="dossier où garder les GeoJSONSeq intermédiaires")
    args = ap.parse_args()

    if not shutil.which("tippecanoe"):
        sys.exit("tippecanoe introuvable (apt install tippecanoe, ou brew install tippecanoe)")

    cells = []
    for p in args.inputs:
        cells += sorted(glob.glob(os.path.join(p, "**", "*.000"), recursive=True)) if os.path.isdir(p) else [p]
    if not cells:
        sys.exit("aucune cellule .000 trouvée")

    frames = []
    # Échelle lue une seule fois par cellule. (En Zélande toutes les cellules sont au 1:2000 :
    # pas de superposition d'échelles à arbitrer ; cscl reste disponible pour le style.)
    for cscl, c in sorted((cell_scale(c), c) for c in cells):
        print(f"lecture {os.path.basename(c)}")
        frames += read_cell(c, cscl)
    gdf = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs="EPSG:4326")
    print(f"{len(gdf)} objets, {gdf['objl'].nunique()} classes")
    print(gdf["objl"].value_counts().to_string())

    is_snd = gdf["objl"] == "SOUNDG"
    snd = gdf[is_snd].reset_index(drop=True)[["depth", "geometry"]].copy()
    snd["minz"] = thin_soundings(snd, zmin=CLASS_MINZOOM["SOUNDG"], zmax=args.maxzoom)
    enc = gdf[~is_snd].reset_index(drop=True).drop(columns=["depth"], errors="ignore")
    scamin = enc["SCAMIN"] if "SCAMIN" in enc else pd.Series([None] * len(enc))
    valdco = enc["VALDCO"] if "VALDCO" in enc else pd.Series([None] * len(enc))
    is_point = enc.geometry.geom_type == "Point"
    enc["minz"] = [
        max(args.minzoom, to_minzoom(s, o, None if pd.isna(v) else float(v), pt))
        for s, o, v, pt in zip(scamin, enc["objl"], valdco, is_point)
    ]
    print("sondes par minzoom:", snd["minz"].value_counts().sort_index().to_dict())

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        if args.keep_geojson:
            tmp = args.keep_geojson
            os.makedirs(tmp, exist_ok=True)
        f_enc, f_snd = os.path.join(tmp, "enc.geojsonl"), os.path.join(tmp, "soundg.geojsonl")
        write_geojsonseq(enc, f_enc, "enc", args.maxzoom)
        write_geojsonseq(snd, f_snd, "soundg", args.maxzoom)
        cmd = [
            "tippecanoe", "-q", "-o", args.output, "--force",
            "-Z", str(args.minzoom), "-z", str(args.maxzoom),
            "-P",                           # lecture parallèle des GeoJSONSeq
            "--no-feature-limit", "--no-tile-size-limit",
            "--no-tiny-polygon-reduction",  # pas de carrés à la place des petits îlots
            "--detect-shared-borders",      # pas de fentes entre polygones de profondeur adjacents
            "--simplification=8",           # ≈ 1 px aux petits zooms
            "--simplification-at-maximum-zoom=4",  # ≈ 1,2 m au zoom 15
            "--name", "ENC Zeeland", "--attribution", "Rijkswaterstaat (CC-0)",
            f_enc, f_snd,
        ]
        subprocess.run(cmd, check=True)

    size = os.path.getsize(args.output)
    print(f"écrit {args.output} ({size / 1e6:.1f} Mo)")
    if size < args.min_bytes:
        # Vu avec tippecanoe 2.49 (Ubuntu 24.04) : tuiles quasi vides, sans erreur
        sys.exit(f"PMTiles anormalement petit ({size} < {args.min_bytes} octets) : vérifier la version de tippecanoe")

    # Manifeste lu par l'app pour vérifier la version de la carte.
    edition = json.load(open(args.meta)) if args.meta else {}
    with open(args.output, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()[:16]
    manifest = {
        "file": os.path.basename(args.output),
        "bytes": size,
        "sha256_16": sha,
        "edition_date": edition.get("date"),
        "edition_title": edition.get("title"),
        "cells": len(cells),
        "bounds": [round(float(v), 4) for v in gdf.total_bounds],
        "minzoom": args.minzoom,
        "maxzoom": args.maxzoom,
    }
    mpath = os.path.splitext(args.output)[0] + ".json"
    with open(mpath, "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f"manifeste {mpath}")


if __name__ == "__main__":
    main()
