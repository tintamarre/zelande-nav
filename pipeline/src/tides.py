#!/usr/bin/env python3
"""Marée astronomique officielle (Rijkswaterstaat, DDL 2.0) des stations de Zélande et de la côte néerlandaise
de la mer du Nord → pleines et basses mers.

Usage:
    uv run python -I src/tides.py -o ../public/tiles/tides.json [--days 30]

Source : Waterwebservices DDL 2.0, grandeur WATHTE, ProcesType « astronomisch » (pas de 10 min, cm/NAP).
Sortie : pour chaque station, la liste des extrêmes [t_ms, hauteur_m, "H"|"L"] et le marnage moyen
de la période (vives-eaux et mortes-eaux comprises), utilisé pour le coefficient de marée.
"""
import argparse
import datetime as dt
import json
import sys
import urllib.request

API = "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen"

# Stations avec prédiction astronomique (vérifiées le 20/10/2026), regroupées par bassin
STATIONS = {
    "westkapelle": ("Westkapelle", 51.5214, 3.44),
    "vlissingen": ("Vlissingen", 51.442, 3.6),
    "terneuzen": ("Terneuzen", 51.3362, 3.8198),
    "hansweert": ("Hansweert", 51.4457, 3.9974),
    "oosterschelde.roompotsluis.buiten": ("Roompot buiten", 51.619, 3.68),
    "stavenisse": ("Stavenisse", 51.598, 4.004),
    "yerseke": ("Yerseke", 51.5062, 4.0751),
    "krammersluizen.west": ("Krammersluizen west", 51.6593, 4.1443),
    # Mer du Nord (couche indicative) : côte et large, de la frontière belge à Scheveningen
    "cadzand.2": ("Cadzand", 51.3793, 3.3763),
    "vlaktevanderaan": ("Vlakte van de Raan", 51.5037, 3.2422),
    "brouwersdam.brouwershavensegat.2": ("Brouwershavense Gat", 51.7665, 3.6217),
    "stellendam.buitenhaven": ("Stellendam", 51.827, 4.0334),
    "goeree.lichteiland": ("Lichteiland Goeree", 51.925, 3.6684),
    "europlatform": ("Europlatform", 51.9978, 3.2751),
    "hoekvanholland": ("Hoek van Holland", 51.9769, 4.1198),
    "scheveningen": ("Scheveningen", 52.099, 4.2636),
}


def fetch(code, start, end):
    body = {
        "Locatie": {"Code": code},
        "AquoPlusWaarnemingMetadata": {"AquoMetadata": {"Grootheid": {"Code": "WATHTE"}, "ProcesType": "astronomisch"}},
        "Periode": {"Begindatumtijd": start.isoformat(timespec="milliseconds"), "Einddatumtijd": end.isoformat(timespec="milliseconds")},
    }
    req = urllib.request.Request(API, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    series = d["WaarnemingenLijst"][0]["MetingenLijst"]
    out = []
    for m in series:
        v = m["Meetwaarde"].get("Waarde_Numeriek")
        if v is None or abs(v) > 1000:  # valeurs manquantes codées 999999999
            continue
        out.append((dt.datetime.fromisoformat(m["Tijdstip"]).timestamp(), v / 100))
    return sorted(out)


def extremes(series):
    """Pleines et basses mers : extrêmes locaux sur ±1 h, affinés par parabole sur 3 points."""
    ev = []
    win = 6  # 6 × 10 min de chaque côté
    for i in range(win, len(series) - win):
        t, h = series[i]
        neigh = [x[1] for x in series[i - win:i + win + 1]]
        kind = "H" if h == max(neigh) else "L" if h == min(neigh) else None
        if not kind:
            continue
        (t0, h0), (t2, h2) = series[i - 1], series[i + 1]
        denom = h0 - 2 * h + h2
        dtp = 0.0 if denom == 0 else 0.5 * (h0 - h2) / denom * (t2 - t0) / 2
        ev.append([round((t + dtp) * 1000), round(h, 2), kind])
    # plateaux : garder un seul extrême par type sur 3 h
    clean = []
    for e in ev:
        if clean and clean[-1][2] == e[2] and e[0] - clean[-1][0] < 3 * 3600_000:
            if (e[2] == "H" and e[1] > clean[-1][1]) or (e[2] == "L" and e[1] < clean[-1][1]):
                clean[-1] = e
            continue
        clean.append(e)
    return clean


def mean_range(ev):
    r = [abs(b[1] - a[1]) for a, b in zip(ev, ev[1:]) if a[2] != b[2]]
    return round(sum(r) / len(r), 2) if r else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--days", type=int, default=30)
    a = ap.parse_args()
    tz = dt.timezone(dt.timedelta(hours=1))
    start = dt.datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0) - dt.timedelta(days=1)
    end = start + dt.timedelta(days=a.days + 1)
    out = {"generated": round(dt.datetime.now(dt.timezone.utc).timestamp() * 1000), "source": "Rijkswaterstaat, marée astronomique (NAP)", "stations": {}}
    for code, (name, lat, lon) in STATIONS.items():
        try:
            ev = extremes(fetch(code, start, end))
        except Exception as e:  # une station en panne ne bloque pas les autres
            print(f"  ! {code}: {e}", file=sys.stderr)
            continue
        if len(ev) < 8 or not mean_range(ev):  # série trop courte : station ignorée plutôt que fausse
            print(f"  ! {code}: seulement {len(ev)} extrêmes", file=sys.stderr)
            continue
        out["stations"][code] = {"name": name, "lat": lat, "lon": lon, "mean_range": mean_range(ev), "events": ev}
        print(f"{name:22} {len(ev):3} extrêmes, marnage moyen {mean_range(ev)} m")
    if len(out["stations"]) < 2:
        sys.exit("trop peu de stations de marée disponibles")
    with open(a.output, "w") as f:
        json.dump(out, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
