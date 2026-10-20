// Prévisions de vent (modèle KNMI HARMONIE via Open-Meteo, CC-BY 4.0) sur une grille couvrant la Zélande.
// La dernière prévision est gardée sur l'appareil pour rester consultable hors-ligne.

export interface WindForecast {
  fetched: number;               // horodatage de la récupération
  times: number[];               // instants (ms, UTC)
  points: { lat: number; lon: number; speed: (number | null)[]; dir: (number | null)[]; gust: (number | null)[] }[]; // null = pas de donnée
}

const KEY = 'zn.wind';
const MAX_AGE_MS = 3 * 3600_000; // au-delà : on tente de rafraîchir

// Grille 0,1° × 0,1° couvrant l'emprise de la carte (51,2–51,9 °N × 3,15–4,55 °E : 8 × 15 = 120 points)
function grid(): { lat: number; lon: number }[] {
  const pts = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 15; j++) pts.push({ lat: +(51.2 + i * 0.1).toFixed(2), lon: +(3.15 + j * 0.1).toFixed(2) });
  return pts;
}

export function cachedWind(): WindForecast | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

export async function loadWind(force = false): Promise<WindForecast | null> {
  const cached = cachedWind();
  if (!force && cached && Date.now() - cached.fetched < MAX_AGE_MS) return cached;
  const pts = grid();
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: pts.map((p) => p.lat).join(','),
    longitude: pts.map((p) => p.lon).join(','),
    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'kn',
    models: 'knmi_seamless',
    forecast_days: '3',
    timezone: 'GMT',
    timeformat: 'unixtime',
  }).toString();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as {
      hourly: { time: number[]; wind_speed_10m: number[]; wind_direction_10m: number[]; wind_gusts_10m: number[] };
    }[];
    const fc: WindForecast = {
      fetched: Date.now(),
      times: data[0].hourly.time.map((t) => t * 1000),
      points: data.map((d, i) => ({
        lat: pts[i].lat,
        lon: pts[i].lon,
        // valeur manquante gardée comme inconnue (jamais transformée en calme)
        speed: d.hourly.wind_speed_10m.map((v) => (v == null ? null : Math.round(v))),
        dir: d.hourly.wind_direction_10m.map((v) => (v == null ? null : Math.round(v))),
        gust: d.hourly.wind_gusts_10m.map((v) => (v == null ? null : Math.round(v))),
      })),
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(fc));
    } catch {
      /* stockage plein ou indisponible : prévision non gardée */
    }
    return fc;
  } catch {
    return cached; // hors connexion : dernière prévision connue
  }
}

/** Index de l'heure la plus proche de `t` (ms). */
export function nearestHour(fc: WindForecast, t: number): number {
  let best = 0;
  fc.times.forEach((x, i) => { if (Math.abs(x - t) < Math.abs(fc.times[best] - t)) best = i; });
  return best;
}

export interface Wind { speed: number; dir: number; gust: number }

/** Échelle de couleur du vent (nœuds → couleur), partagée par la carte et le bandeau. */
export const WIND_SCALE: [number, string][] = [[0, '#2f7fd8'], [11, '#1f9e3a'], [17, '#e0a000'], [22, '#e05a00'], [28, '#d11a1a'], [34, '#9b00b0']];
export const WIND_SCALE_NIGHT: [number, string][] = [[0, '#4a5a70'], [11, '#4a6a48'], [17, '#7a6a30'], [22, '#7a4a28'], [28, '#7a2a2a'], [34, '#6a2a70']];
export const windColourFor = (kn: number, night = false) =>
  (night ? WIND_SCALE_NIGHT : WIND_SCALE).reduce((c, [min, col]) => (kn >= min ? col : c), WIND_SCALE[0][1]);

// Axes de la grille (latitudes, longitudes triées), calculés une fois par prévision
const axesCache = new WeakMap<WindForecast, { lats: number[]; lons: number[] }>();
function axes(fc: WindForecast) {
  let a = axesCache.get(fc);
  if (!a) {
    a = {
      lats: [...new Set(fc.points.map((p) => p.lat))].sort((x, y) => x - y),
      lons: [...new Set(fc.points.map((p) => p.lon))].sort((x, y) => x - y),
    };
    axesCache.set(fc, a);
  }
  return a;
}

/** Vrai si le point est couvert par la grille de prévision (marge d'une demi-maille). */
export function inForecast(fc: WindForecast, lat: number, lon: number): boolean {
  const { lats, lons } = axes(fc);
  const h = (lats[1] - lats[0]) / 2;
  return lat >= lats[0] - h && lat <= lats.at(-1)! + h && lon >= lons[0] - h && lon <= lons.at(-1)! + h;
}

/**
 * Vent interpolé en un point (bilinéaire sur la grille, en composantes u/v pour éviter le saut
 * 359° → 0°). Hors grille : valeur du bord le plus proche (voir inForecast).
 */
export function windAt(fc: WindForecast, hour: number, lat: number, lon: number): Wind | null {
  const { lats, lons } = axes(fc);
  const at = (i: number, j: number) => fc.points[i * lons.length + j];
  const pos = (v: number, axis: number[]) => {
    const f = Math.min(Math.max((v - axis[0]) / (axis[1] - axis[0]), 0), axis.length - 1);
    const i = Math.min(Math.floor(f), axis.length - 2);
    return [i, f - i] as const;
  };
  const [i, fy] = pos(lat, lats);
  const [j, fx] = pos(lon, lons);
  let u = 0, v = 0, gust = 0, wsum = 0;
  for (const [di, dj, w] of [[0, 0, (1 - fy) * (1 - fx)], [0, 1, (1 - fy) * fx], [1, 0, fy * (1 - fx)], [1, 1, fy * fx]] as const) {
    const p = at(i + di, j + dj);
    const sp = p.speed[hour], dir = p.dir[hour], gu = p.gust[hour];
    if (sp == null || dir == null || w === 0) continue; // point sans donnée : ignoré
    const r = (dir * Math.PI) / 180;
    u += w * sp * Math.sin(r);
    v += w * sp * Math.cos(r);
    gust += w * (gu ?? sp);
    wsum += w;
  }
  if (wsum === 0) return null;
  u /= wsum; v /= wsum; gust /= wsum;
  return { speed: Math.hypot(u, v), dir: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360, gust };
}

/** Points de vent répartis sur l'écran (tous les `spacing` px), seulement là où la prévision existe. */
export function windScreenGrid(
  fc: WindForecast, hour: number, width: number, height: number, spacing: number,
  unproject: (x: number, y: number) => { lng: number; lat: number },
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let y = spacing / 2; y < height; y += spacing) {
    for (let x = spacing / 2; x < width; x += spacing) {
      const { lng, lat } = unproject(x, y);
      if (!inForecast(fc, lat, lng)) continue;
      const w = windAt(fc, hour, lat, lng);
      if (!w) continue;
      features.push({
        type: 'Feature',
        properties: { speed: Math.round(w.speed), gust: Math.round(w.gust), to: (w.dir + 180) % 360 },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// Limite basse (nœuds) des forces 1 à 12
const BEAUFORT = [1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64];
export const beaufort = (kn: number) => BEAUFORT.filter((b) => kn >= b).length;

/** Allure et amure à partir du vent (d'où il vient) et du cap fond. */
export function pointOfSail(windFrom: number, cog: number): string {
  const twa = (windFrom - cog + 360) % 360;
  const a = Math.min(twa, 360 - twa);
  const tack = twa > 180 ? 'bâbord amures' : 'tribord amures';
  if (a < 40) return 'face au vent';
  if (a < 70) return `près, ${tack}`;
  if (a < 110) return `travers, ${tack}`;
  if (a < 155) return `largue, ${tack}`;
  return `vent arrière, ${tack}`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export const compass = (deg: number) => COMPASS[Math.round(deg / 22.5) % 16];
