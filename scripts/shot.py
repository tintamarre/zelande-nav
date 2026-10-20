"""Capture d'écran de l'app (Chromium headless) pour vérifier le rendu.

Usage:
    uv run --with playwright python -I scripts/shot.py <url> <sortie.png> [--lat 51.6 --lon 3.9 --zoom 13]
        [--width 420 --height 760] [--geo LAT,LON] [--eval "js"]
"""
import argparse

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("url")
ap.add_argument("out")
ap.add_argument("--lat", type=float)
ap.add_argument("--lon", type=float)
ap.add_argument("--zoom", type=float)
ap.add_argument("--width", type=int, default=420)
ap.add_argument("--height", type=int, default=760)
ap.add_argument("--geo", help="position GPS simulée LAT,LON")
ap.add_argument("--eval", help="JavaScript à exécuter avant la capture")
a = ap.parse_args()

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    ctx_opts = {"viewport": {"width": a.width, "height": a.height}, "device_scale_factor": 2}
    if a.geo:
        lat, lon = map(float, a.geo.split(","))
        ctx_opts |= {"geolocation": {"latitude": lat, "longitude": lon, "accuracy": 8}, "permissions": ["geolocation"]}
    ctx = b.new_context(**ctx_opts)
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    pg.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    pg.goto(a.url)
    pg.wait_for_function("window.map && window.map.getSource('enc')", timeout=30000)
    if a.lat is not None:
        pg.evaluate(f"map.jumpTo({{center: [{a.lon}, {a.lat}], zoom: {a.zoom or 13}}})")
    if a.eval:
        pg.evaluate(a.eval)
    pg.wait_for_timeout(500)
    pg.evaluate("new Promise(r => map.loaded() && map.areTilesLoaded() ? r() : map.once('idle', r))")
    pg.wait_for_timeout(1500)
    pg.screenshot(path=a.out)
    print("\n".join(l for l in logs if not l.startswith("debug"))[-3000:])
    b.close()
