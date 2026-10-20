// Courants de marée ESTIMÉS (indicatifs) : grille précalculée (pipeline/src/currents.py) animée par
// la marée astronomique officielle de Rijkswaterstaat (pipeline/src/tides.py).
//
// Modèle, à la manière d'un atlas de courants : le flot porte de l'étale de basse mer à l'étale de
// pleine mer, le jusant ensuite ; l'étale suit la pleine/basse mer locale de SLACK_MIN ; la vitesse
// suit une demi-sinusoïde entre deux étales, maximale à mi-parcours, proportionnelle au marnage du
// jour rapporté au marnage moyen (vives-eaux / mortes-eaux).

export type TideEvent = [number, number, 'H' | 'L']; // instant (ms), hauteur (m/NAP), pleine ou basse mer
export interface TideStation { name: string; lat: number; lon: number; mean_range: number; events: TideEvent[] }
export interface Tides { generated: number; source: string; stations: Record<string, TideStation> }
// [lat, lon, direction du flot (°), vitesse max à marée moyenne (kn), station 1, station 2, poids station 1]
export type CurrentPoint = [number, number, number, number, string, string, number];
export interface CurrentGrid { points: CurrentPoint[] }

const SLACK_MIN = 35; // étale ≈ 35 min après la pleine/basse mer locale (ordre de grandeur en Zélande)

/** Cycle à l'instant t pour une station : facteur signé (+ flot, − jusant) et coefficient de marnage. */
function stationPhase(st: TideStation, t: number): { u: number; coef: number; nextSlack: number } | null {
  const ev = st.events;
  const slack = (i: number) => ev[i][0] + SLACK_MIN * 60_000;
  let k = -1;
  for (let i = 0; i < ev.length - 1; i++) if (slack(i) <= t && t < slack(i + 1)) { k = i; break; }
  if (k < 0) return null; // hors de la période couverte par les prédictions
  const span = slack(k + 1) - slack(k);
  const sign = ev[k][2] === 'L' ? 1 : -1; // après la basse mer : flot
  const coef = Math.min(1.5, Math.max(0.5, Math.abs(ev[k + 1][1] - ev[k][1]) / st.mean_range));
  return { u: sign * Math.sin((Math.PI * (t - slack(k))) / span), coef, nextSlack: slack(k + 1) };
}

export interface Current { speed: number; dir: number; flood: boolean; nextSlack: number }

export function currentAt(p: CurrentPoint, tides: Tides, t: number): Current | null {
  const [, , floodDir, vmax, s1, s2, w1] = p;
  const a = tides.stations[s1] && stationPhase(tides.stations[s1], t);
  const b = tides.stations[s2] && stationPhase(tides.stations[s2], t);
  if (!a && !b) return null;
  const pa = a ?? b!, pb = b ?? a!;
  const w = a && b ? w1 : 1;
  const u = w * pa.u * pa.coef + (1 - w) * pb.u * pb.coef;
  return {
    speed: vmax * Math.abs(u),
    dir: u >= 0 ? floodDir : (floodDir + 180) % 360,
    flood: u >= 0,
    nextSlack: w * pa.nextSlack + (1 - w) * pb.nextSlack,
  };
}

/** Point de grille le plus proche (dans `maxKm`), pour le bandeau. */
export function nearestPoint(grid: CurrentGrid, lat: number, lon: number, maxKm = 1.5): CurrentPoint | null {
  let best: CurrentPoint | null = null, bd = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (const p of grid.points) {
    const d = (p[0] - lat) ** 2 + ((p[1] - lon) * k) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best && Math.sqrt(bd) * 111 <= maxKm ? best : null;
}

/** Prochaines pleine et basse mers à la station la plus proche. */
export function nextTides(tides: Tides, lat: number, lon: number, t: number): { station: string; hw?: TideEvent; lw?: TideEvent } | null {
  const k = Math.cos((lat * Math.PI) / 180);
  const st = Object.values(tides.stations).reduce<TideStation | null>((a, s) =>
    !a || (s.lat - lat) ** 2 + ((s.lon - lon) * k) ** 2 < (a.lat - lat) ** 2 + ((a.lon - lon) * k) ** 2 ? s : a, null);
  if (!st) return null;
  const next = st.events.filter((e) => e[0] > t);
  return { station: st.name, hw: next.find((e) => e[2] === 'H'), lw: next.find((e) => e[2] === 'L') };
}

/** Courants répartis sur l'écran : un point de grille par case de `spacing` px. */
export function currentScreenFeatures(
  grid: CurrentGrid, tides: Tides, t: number, width: number, height: number, spacing: number,
  project: (lon: number, lat: number) => { x: number; y: number },
): GeoJSON.FeatureCollection {
  const taken = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const p of grid.points) {
    const { x, y } = project(p[1], p[0]);
    if (x < 0 || y < 0 || x > width || y > height) continue;
    const cell = `${Math.floor(x / spacing)},${Math.floor(y / spacing)}`;
    if (taken.has(cell)) continue;
    const c = currentAt(p, tides, t);
    if (!c) continue;
    taken.add(cell);
    features.push({
      type: 'Feature',
      properties: { speed: Math.round(c.speed * 10) / 10, to: Math.round(c.dir) },
      geometry: { type: 'Point', coordinates: [p[1], p[0]] },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Échelle de couleur du courant (nœuds), distincte de celle du vent. */
export const CURRENT_SCALE: [number, string][] = [[0, '#8a9aa8'], [0.3, '#4fb3d9'], [1, '#1f6fd0'], [2, '#5b3fd0'], [3, '#b0179b']];
export const CURRENT_SCALE_NIGHT: [number, string][] = [[0, '#40484f'], [0.3, '#2f5a6a'], [1, '#2a3f6a'], [2, '#3f2f6a'], [3, '#5a2a55']];
