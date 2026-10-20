#!/usr/bin/env python3
"""Inventaire des cellules S-57 : échelle, emprise, zéro hydrographique, classes présentes.

Usage:
    uv run python -I src/inspect_cells.py data/zeeland [--json out.json]
"""
import argparse
import collections
import glob
import json
import os

import pyogrio

OPEN_OPTS = {"UPDATES": "APPLY", "RETURN_PRIMITIVES": "OFF", "RETURN_LINKAGES": "OFF", "LNAM_REFS": "OFF"}

# S-57 VDAT/SDAT (sous-ensemble)
DATUMS = {
    "1": "MLWS", "2": "MLLWS", "3": "MSL", "4": "LLW", "5": "MLW", "12": "MLLW",
    "17": "MHWS", "23": "LAT", "24": "Local datum", "26": "LWL", "27": "HAT",
    "28": "Nearly LAT", "30": "Local low water ref. level", "31": "Local high water ref. level",
    "33": "Hydro. zero (inland)", "44": "Baltic Sea CD",
}


def inspect(path):
    layers = [name for name, _ in pyogrio.list_layers(path)]
    dsid = pyogrio.read_dataframe(path, layer="DSID", read_geometry=False, **OPEN_OPTS)
    row = dsid.iloc[0].to_dict() if not dsid.empty else {}
    info = pyogrio.read_info(path, layer="M_COVR") if "M_COVR" in layers else {}
    bounds = info.get("total_bounds")
    return {
        "cell": os.path.splitext(os.path.basename(path))[0],
        "cscl": int(row.get("DSPM_CSCL") or 0),
        "vdat": DATUMS.get(str(row.get("DSPM_VDAT")), row.get("DSPM_VDAT")),
        "sdat": DATUMS.get(str(row.get("DSPM_SDAT")), row.get("DSPM_SDAT")),
        "edition": row.get("DSID_EDTN"),
        "update": row.get("DSID_UPDN"),
        "issued": row.get("DSID_ISDT"),
        "bounds": [round(float(b), 4) for b in bounds] if bounds is not None else None,
        "layers": layers,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--json")
    a = ap.parse_args()
    cells = sorted(glob.glob(os.path.join(a.folder, "**", "*.000"), recursive=True))
    rows = [inspect(c) for c in cells]
    classes = collections.Counter(l for r in rows for l in r["layers"])
    print(f"{len(rows)} cellules")
    for r in sorted(rows, key=lambda r: (r["cscl"], r["cell"])):
        print(f"{r['cell']:10} 1:{r['cscl']:<7} sdat={r['sdat']!s:<22} vdat={r['vdat']!s:<22} {r['bounds']}")
    print("\nclasses (nb de cellules):")
    print(", ".join(f"{k}:{v}" for k, v in sorted(classes.items())))
    if a.json:
        json.dump(rows, open(a.json, "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
