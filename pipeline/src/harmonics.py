#!/usr/bin/env python3
"""Constantes harmoniques des ports hors Pays-Bas (France, Belgique, Angleterre) → harmonics.json (versionné).

Usage (à relancer rarement, par exemple une fois par an) :
    uv run python -I src/harmonics.py [-o harmonics.json] [--days 365]

Rijkswaterstaat ne publie que les marées néerlandaises, et les prédictions du SHOM, de l'UKHO et de la
Vlaamse Hydrografie ne sont pas libres. Les MESURES de leurs marégraphes le sont, relayées par le réseau
IOC Sea Level Station Monitoring Facility (UNESCO/VLIZ) : on refait donc ce que font les annuaires, une
analyse harmonique d'un an de mesures (utide, moindres carrés robustes, ~60 composantes, ondes de faible
profondeur comprises), puis tides.py prédit chaque jour pleines et basses mers à partir de ces constantes.

Hauteurs : le zéro des marégraphes IOC est arbitraire. Elles sont rapportées à la plus basse mer
astronomique calculée sur 19 ans (cycle nodal) à partir des constantes, soit le zéro des cartes anglais
et belge (LAT) et, à quelques décimètres près, le zéro hydrographique français.
Contrôle : Vlissingen est analysé de la même façon et comparé à la prédiction officielle (--check).
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.request

import numpy as np
import utide

IOC = "https://www.ioc-sealevelmonitoring.org/service.php?query=data&code={code}&timestart={a}&timestop={b}&format=json"
UA = "zelande-nav/1.0 (+https://github.com/tintamarre/zelande-nav)"

# code IOC : (nom affiché, lat, lon)
STATIONS = {
    "hasp": ("Hastings", 50.8509, 0.5729),
    "boul": ("Boulogne-sur-Mer", 50.7275, 1.5775),
    "cala": ("Calais", 50.9694, 1.8677),
    "dove": ("Douvres", 51.1144, 1.3226),
    "dlpr": ("Deal", 51.2238, 1.4093),
    "dunk": ("Dunkerque", 51.0481, 2.3667),
    "nieu": ("Nieuport", 51.1506, 2.7281),
    "oste": ("Ostende", 51.2343, 2.9267),
    "zldw": ("Zeebrugge", 51.3464, 3.2003),
    "mpcw": ("Westhinder (large)", 51.3886, 2.4378),
    "hbay": ("Herne Bay", 51.3821, 1.1152),
    "shee": ("Sheerness", 51.4456, 0.7434),
    "harw": ("Harwich", 51.9480, 1.2921),
}


def fetch(code, start, days, cache):
    """Mesures IOC (au plus 31 jours par requête), gardées en cache par tranche."""
    t, h = [], []
    os.makedirs(cache, exist_ok=True)
    a = start
    while a < start + dt.timedelta(days=days):
        b = min(a + dt.timedelta(days=30), start + dt.timedelta(days=days))
        path = os.path.join(cache, f"{code}-{a:%Y%m%d}-{b:%Y%m%d}.json")
        if not os.path.exists(path):
            for attempt in range(3):
                try:
                    req = urllib.request.Request(IOC.format(code=code, a=f"{a:%Y-%m-%d}", b=f"{b:%Y-%m-%d}"), headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=120) as r:
                        data = json.load(r)
                    break
                except (OSError, ValueError) as e:
                    print(f"  ! {code} {a:%Y-%m-%d} : {e}", file=sys.stderr)
                    time.sleep(10 * (attempt + 1))
            else:
                data = []
            with open(path, "w") as f:
                json.dump(data, f)
        with open(path) as f:
            for x in json.load(f) if os.path.getsize(path) else []:
                if isinstance(x, dict) and x.get("slevel") is not None:
                    t.append(np.datetime64(x["stime"].replace(" ", "T")))
                    h.append(float(x["slevel"]))
        a = b
    t, h = np.array(t, dtype="datetime64[s]"), np.array(h)
    t, idx = np.unique(t, return_index=True)
    return t, h[idx]


def clean(t, h):
    """Mesures ramenées à un pas de 10 min, sans valeurs absurdes ni journées décalées.

    Les marégraphes IOC mêlent des pas de 1 à 15 min, des pics aberrants (Calais : −4 245 m) et des
    changements de zéro (Douvres, juin 2026 : −4,7 m pendant des semaines) : bornes absolues, moyenne par
    tranche de 10 min (même poids quel que soit le pas), puis journées dont le niveau moyen s'écarte de plus
    de 1 m de la médiane écartées (une surcote ne dure pas des jours ; un capteur décalé, si)."""
    ok = np.isfinite(h)
    t, h = t[ok], h[ok]
    ok = np.abs(h - np.median(h)) < 15
    t, h = t[ok], h[ok]
    b = t.astype("int64") // 600 * 600
    ub, inv = np.unique(b, return_inverse=True)
    h = np.bincount(inv, weights=h) / np.bincount(inv)
    t = ub.astype("datetime64[s]")
    day = t.astype("datetime64[D]")
    _, dinv = np.unique(day, return_inverse=True)
    n = np.bincount(dinv)
    dmean = np.bincount(dinv, weights=h) / n
    full = n >= 72  # au moins 12 h de mesures : moyenne journalière significative
    good = full & (np.abs(dmean - np.median(dmean[full])) < 1.0)
    keep = good[dinv]
    return t[keep], h[keep]


def to_json(o):
    if isinstance(o, dict):
        return {k: to_json(v) for k, v in o.items()}
    if isinstance(o, np.ndarray):
        if np.iscomplexobj(o):
            return {"__nd__": o.real.tolist(), "imag": o.imag.tolist(), "dtype": str(o.dtype)}
        return {"__nd__": o.tolist(), "dtype": str(o.dtype)}
    if isinstance(o, (np.floating, np.integer, np.bool_)):
        return o.item()
    if isinstance(o, (complex, np.complexfloating)):
        return {"__c__": [o.real, o.imag]}
    if isinstance(o, (list, tuple)):
        return [to_json(v) for v in o]
    return o


def from_json(o):
    """Inverse de to_json : coefficients utide (Bunch) prêts pour utide.reconstruct."""
    if isinstance(o, dict):
        if "__nd__" in o:
            if "imag" in o:
                return (np.array(o["__nd__"]) + 1j * np.array(o["imag"])).astype(o["dtype"])
            return np.array(o["__nd__"], dtype=o["dtype"])
        if "__c__" in o:
            return complex(*o["__c__"])
        return utide.utilities.Bunch({k: from_json(v) for k, v in o.items()})
    if isinstance(o, list):
        return [from_json(v) for v in o]
    return o


def predict(coef, t):
    """Hauteur prédite (m, référence du marégraphe) aux instants t (datetime64)."""
    return utide.reconstruct(t, coef, verbose=False).h


def analyse(code, lat, start, days, cache):
    t, h = fetch(code, start, days, cache)
    n0 = len(t)
    t, h = clean(t, h)
    span = (t[-1] - t[0]).astype("timedelta64[D]").astype(int) if len(t) else 0
    if len(t) < 5000 or span < 300:
        raise ValueError(f"série trop courte ({len(t)} mesures sur {span} jours)")
    opts = dict(lat=lat, method="robust", conf_int="none", trend=False, verbose=False)
    coef = utide.solve(t, h, **opts)
    # Seconde passe sans les mesures aberrantes restantes, repérées sur le résidu (la surcote, lente et lisse)
    resid = h - predict(coef, t)
    dev = np.abs(resid - np.median(resid))
    ok = dev < max(1.0, 6 * np.median(dev))
    t, h = t[ok], h[ok]
    coef = utide.solve(t, h, **opts)
    # Plus basse mer astronomique sur un cycle nodal (19 ans, pas horaire)
    tt = np.arange(np.datetime64("2026-01-01T00:00"), np.datetime64("2045-01-01T00:00"), np.timedelta64(1, "h"))
    lat_level = float(predict(coef, tt).min())
    resid = h - predict(coef, t)
    return coef, lat_level, {"mesures": int(n0), "gardées": int(len(t)), "jours": int(span),
                             "écart_type_résidu_m": round(float(np.std(resid)), 3), "composantes": len(coef["name"])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--output", default="harmonics.json")
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--end", default="2026-10-01", help="fin de la période analysée (AAAA-MM-JJ)")
    ap.add_argument("--cache", default="data/ioc")
    ap.add_argument("--only", nargs="*", help="codes IOC à traiter (défaut : tous)")
    ap.add_argument("--check", action="store_true", help="contrôle sur Vlissingen contre la prédiction Rijkswaterstaat")
    a = ap.parse_args()
    end = dt.datetime.fromisoformat(a.end)
    start = end - dt.timedelta(days=a.days)
    stations = {"vlis": ("Vlissingen", 51.4429, 3.5970)} if a.check else {k: v for k, v in STATIONS.items() if not a.only or k in a.only}
    out = {"source": "Analyse harmonique (utide) des mesures IOC Sea Level Station Monitoring Facility",
           "period": [f"{start:%Y-%m-%d}", f"{end:%Y-%m-%d}"], "stations": {}}
    if os.path.exists(a.output) and not a.check:
        with open(a.output) as f:
            out["stations"] = json.load(f).get("stations", {})
    for code, (name, lat, lon) in stations.items():
        try:
            coef, lat_level, info = analyse(code, lat, start, a.days, a.cache)
        except Exception as e:  # une station en panne ne bloque pas les autres
            print(f"  ! {code} ({name}) : {e}", file=sys.stderr)
            continue
        print(f"{name:22} {info}")
        # rf, weights : diagnostics de la régression robuste (un poids par mesure), inutiles pour prédire
        slim = {k: v for k, v in coef.items() if k not in ("rf", "weights")}
        out["stations"][code] = {"name": name, "lat": lat, "lon": lon, "lat_level": round(lat_level, 3),
                                 "info": info, "coef": to_json(slim)}
    path = a.output if not a.check else os.path.join(a.cache, "harmonics-check.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"→ {path} ({os.path.getsize(path) / 1000:.0f} Ko)")


if __name__ == "__main__":
    main()
