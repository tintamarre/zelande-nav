// Prévisions de vent (modèle KNMI HARMONIE via Open-Meteo, CC-BY 4.0) sur une grille couvrant la Zélande.
// La dernière prévision est gardée sur l'appareil pour rester consultable hors-ligne.

export interface WindForecast {
  fetched: number;               // horodatage de la récupération
  times: number[];               // instants (ms, UTC)
  points: { lat: number; lon: number; speed: number[]; dir: number[]; gust: number[] }[];
}

const KEY = 'zn.wind';
const MAX_AGE_MS = 3 * 3600_000; // au-delà : on tente de rafraîchir

// Grille 0,1° × 0,1° sur l'emprise de la carte (8 × 15 = 120 points)
function grid(): { lat: number; lon: number }[] {
  const pts = [];
  for (let lat = 51.2; lat <= 51.85; lat += 0.1) for (let lon = 3.15; lon <= 4.55; lon += 0.1) pts.push({ lat: +lat.toFixed(2), lon: +lon.toFixed(2) });
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
        speed: d.hourly.wind_speed_10m.map((v) => Math.round(v ?? 0)),
        dir: d.hourly.wind_direction_10m.map((v) => Math.round(v ?? 0)),
        gust: d.hourly.wind_gusts_10m.map((v) => Math.round(v ?? 0)),
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

export function windGeoJSON(fc: WindForecast, hour: number): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: fc.points.map((p) => ({
      type: 'Feature',
      properties: { speed: p.speed[hour], dir: p.dir[hour], gust: p.gust[hour] },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export const compass = (deg: number) => COMPASS[Math.round(deg / 22.5) % 16];
