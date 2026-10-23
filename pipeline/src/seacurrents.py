#!/usr/bin/env python3
"""Courants de la mer du Nord (couche indicative) : prévision horaire du modèle SMOC → seacurrents.json.

Usage:
    uv run python -I src/seacurrents.py --points ../public/tiles/ns-current-points.json -o ../public/tiles/seacurrents.json

Au large, la marée se propage le long de la côte : le courant porte au NE vers la pleine mer et s'inverse
environ 3 h plus tard, alors que dans les estuaires l'étale suit la pleine mer. L'estimation de type atlas
de currents.py (Zélande) ne s'y transpose pas ; on prend ici le modèle SMOC de Mercator (Copernicus Marine,
maille 1/12° ≈ 8 km : marée, vent et circulation générale), servi par l'API marine d'Open-Meteo (CC-BY 4.0).
Points : mailles du modèle en mer du Nord hors carte officielle (northsea.py, current_points.json).
Recalculé chaque jour en CI, comme les marées : de la veille à 4 jours, pour le curseur horaire (−6 h à +72 h).
"""
import argparse
import datetime as dt
import json
import sys
import time
import urllib.parse
import urllib.request

API = "https://marine-api.open-meteo.com/v1/marine"
UA = "zelande-nav/1.0 (+https://github.com/tintamarre/zelande-nav)"
BATCH = 100  # points par requête (URL raisonnable)
KMH_TO_KN = 1 / 1.852


def fetch(batch):
    q = urllib.parse.urlencode({
        "latitude": ",".join(str(p[0]) for p in batch),
        "longitude": ",".join(str(p[1]) for p in batch),
        "hourly": "ocean_current_velocity,ocean_current_direction",
        "past_days": 1, "forecast_days": 4, "timezone": "GMT", "timeformat": "unixtime", "cell_selection": "sea",
    })
    for attempt in range(1, 4):
        try:
            req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.load(r)
            return data if isinstance(data, list) else [data]
        except OSError as e:
            if attempt == 3:
                raise
            print(f"  ! essai {attempt}/3 : {e}", file=sys.stderr)
            time.sleep(20 * attempt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--points", required=True, help="current_points.json produit par northsea.py")
    ap.add_argument("-o", "--output", required=True)
    a = ap.parse_args()
    with open(a.points) as f:
        pts = json.load(f)
    times, out_pts, speed, direction, seen = None, [], [], [], set()
    for i in range(0, len(pts), BATCH):
        for d in fetch(pts[i:i + BATCH]):
            h = d["hourly"]
            if times is None:
                times = [t * 1000 for t in h["time"]]
            elif len(h["time"]) != len(times) or h["time"][0] * 1000 != times[0]:
                sys.exit("séries horaires de longueurs différentes : réponse inattendue")
            key = (round(d["latitude"], 3), round(d["longitude"], 3))
            v, dirs = h["ocean_current_velocity"], h["ocean_current_direction"]
            if key in seen or sum(x is not None for x in v) < len(v) * 0.9:
                continue  # maille déjà servie (point déplacé vers la mer) ou série lacunaire
            seen.add(key)
            out_pts.append([round(d["latitude"], 4), round(d["longitude"], 4)])
            # dixièmes de nœud (entiers : fichier compact) ; direction vers laquelle porte le courant
            speed.append([None if x is None else round(x * KMH_TO_KN * 10) for x in v])
            direction.append([None if x is None else round(x) % 360 for x in dirs])
    if len(out_pts) < 50:
        sys.exit(f"trop peu de points de courant mer du Nord ({len(out_pts)})")
    with open(a.output, "w") as f:
        json.dump({"source": "Mercator SMOC (Copernicus Marine) via Open-Meteo (CC-BY 4.0)",
                   "generated": round(dt.datetime.now(dt.timezone.utc).timestamp() * 1000),
                   "times": times, "points": out_pts, "speed_dkn": speed, "dir": direction}, f, separators=(",", ":"))
    print(f"courants mer du Nord : {len(out_pts)} points × {len(times)} h → {a.output}")


if __name__ == "__main__":
    main()
