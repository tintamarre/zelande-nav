#!/usr/bin/env python3
"""Télécharge la dernière édition IENC Rijkswaterstaat d'une zone, via le catalogue OpenCPN.

Usage:
    python3 -I fetch_ienc.py --area zeeland --dest data/
    python3 -I fetch_ienc.py --list
    python3 -I fetch_ienc.py --area zeeland --date   # date de la dernière édition (pour la CI)

Le catalogue (chartcatalogs/catalogs, régénéré quotidiennement) donne l'URL vaarweginformatie.nl
de l'édition hebdomadaire. Le fileId change à chaque édition : ne jamais le coder en dur.
Licence des données : CC-0 (data.overheid.nl, dataset 55088).
"""
import argparse
import json
import os
import shutil
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

CATALOG = "https://raw.githubusercontent.com/chartcatalogs/catalogs/master/NL_IENC_Catalog.xml"
AREAS = {"zeeland": "Zeeland", "waddenzee": "Waddenzee", "nederland": "Nederland"}


def charts():
    with urllib.request.urlopen(CATALOG, timeout=60) as r:
        root = ET.fromstring(r.read())
    for ch in root.findall(".//chart"):
        d = {c.tag: (c.text or "").strip() for c in ch}
        yield {
            "title": d.get("title", ""),
            "url": d.get("zipfile_location", ""),
            "date": d.get("zipfile_datetime_iso8601", ""),
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--area", choices=AREAS, default="zeeland")
    ap.add_argument("--dest", default="data")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--date", action="store_true", help="affiche seulement la date de la dernière édition")
    a = ap.parse_args()

    items = list(charts())
    if a.list:
        for c in items:
            print(f"{c['date']}  {c['title']}")
        return
    match = [c for c in items if c["title"].startswith(AREAS[a.area])]
    if not match:
        sys.exit(f"zone {a.area} absente du catalogue")
    c = match[0]
    if a.date:
        print(c["date"])
        return
    os.makedirs(a.dest, exist_ok=True)
    zpath = os.path.join(a.dest, f"{a.area}.zip")
    meta_path = os.path.join(a.dest, f"{a.area}.json")
    if os.path.exists(meta_path) and os.path.isdir(os.path.join(a.dest, a.area)):
        with open(meta_path) as f:
            if json.load(f).get("date") == c["date"]:
                print(f"déjà à jour ({c['date']})")
                return
    print(f"téléchargement {c['title']} ({c['date']})")
    with urllib.request.urlopen(c["url"], timeout=300) as r, open(zpath, "wb") as f:
        shutil.copyfileobj(r, f)
    out = os.path.join(a.dest, a.area)
    # Le ZIP contient un dossier par semaine : vider l'ancienne édition pour ne pas doubler les cellules
    shutil.rmtree(out, ignore_errors=True)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(out)
    os.remove(zpath)
    with open(meta_path, "w") as f:
        json.dump(c, f, ensure_ascii=False, indent=1)
    cells = [f for _, _, fs in os.walk(out) for f in fs if f.endswith(".000")]
    print(f"{len(cells)} cellules .000 extraites dans {out}")


if __name__ == "__main__":
    main()
