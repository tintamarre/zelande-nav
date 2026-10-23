// Courants de marée ESTIMÉS (indicatifs) : grille précalculée (pipeline/src/currents.py) animée par
// la marée astronomique officielle de Rijkswaterstaat (pipeline/src/tides.py).
//
// Modèle, à la manière d'un atlas de courants : le flot porte de l'étale de basse mer à l'étale de
// pleine mer, le jusant ensuite ; l'étale suit la pleine/basse mer locale de SLACK_MIN ; la vitesse
// suit une demi-sinusoïde entre deux étales, maximale à mi-parcours, proportionnelle au marnage du
// jour rapporté au marnage moyen (vives-eaux / mortes-eaux). Les hauteurs sont en m NAP.

export type TideEvent = [number, number, 'H' | 'L']; // instant (ms), hauteur (m/NAP), pleine ou basse mer
// datum : référence des hauteurs, « NAP » (Rijkswaterstaat) ou « ZC » (zéro des cartes : ports voisins, constantes harmoniques)
export interface TideStation { name: string; lat: number; lon: number; mean_range: number; datum?: 'NAP' | 'ZC'; events: TideEvent[] }
export interface Tides { generated: number; source: string; stations: Record<string, TideStation> }
// [lat, lon, direction du flot (°), vitesse max à marée moyenne (kn), station 1, station 2, poids station 1]
export type CurrentPoint = [number, number, number, number, string, string, number];
export interface CurrentGrid { points: CurrentPoint[] }

const SLACK_MIN = 35; // étale ≈ 35 min après la pleine/basse mer locale (ordre de grandeur en Zélande)

interface Pseudo { events: TideEvent[]; meanRange: number }

/**
 * Marée « locale » d'un point : heures et hauteurs des PM/BM des deux stations voisines, moyennées avec
 * leur poids (chaque événement de la 1re station est apparié au même type le plus proche de la 2e).
 * Une seule phase en découle : vitesse, sens et étale restent cohérents entre eux.
 */
const pseudoCache = new WeakMap<Tides, Map<string, Pseudo | null>>();
function pseudoStation(tides: Tides, s1: string, s2: string, w1: number): Pseudo | null {
  let cache = pseudoCache.get(tides);
  if (!cache) { cache = new Map(); pseudoCache.set(tides, cache); }
  const key = `${s1}|${s2}|${w1}`;
  if (cache.has(key)) return cache.get(key)!;
  const a = tides.stations[s1], b = tides.stations[s2];
  let res: Pseudo | null = null;
  if (a?.mean_range && b?.mean_range && s1 !== s2 && w1 < 1) {
    const events: TideEvent[] = [];
    for (const e of a.events) {
      const m = b.events.filter((x) => x[2] === e[2] && Math.abs(x[0] - e[0]) < 3 * 3600_000)
        .sort((x, y) => Math.abs(x[0] - e[0]) - Math.abs(y[0] - e[0]))[0];
      if (m) events.push([w1 * e[0] + (1 - w1) * m[0], w1 * e[1] + (1 - w1) * m[1], e[2]]);
    }
    res = { events, meanRange: w1 * a.mean_range + (1 - w1) * b.mean_range };
  } else {
    const st = a?.mean_range ? a : b?.mean_range ? b : null;
    if (st) res = { events: st.events, meanRange: st.mean_range };
  }
  cache.set(key, res);
  return res;
}

/** Cycle à l'instant t : facteur signé (+ flot, − jusant), coefficient de marnage, prochaine étale. */
function phase(ps: Pseudo, t: number): { u: number; coef: number; nextSlack: number } | null {
  const ev = ps.events;
  const slack = (i: number) => ev[i][0] + SLACK_MIN * 60_000;
  // recherche dichotomique du dernier étale ≤ t
  let lo = 0, hi = ev.length - 1;
  if (hi < 1 || t < slack(0) || t >= slack(hi)) return null; // hors de la période couverte
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (slack(mid) <= t) lo = mid; else hi = mid; }
  const k = lo;
  if (ev[k][2] === ev[k + 1][2]) return null; // extrême manquant : pas d'estimation plutôt qu'une fausse
  const span = slack(k + 1) - slack(k);
  const sign = ev[k][2] === 'L' ? 1 : -1; // après la basse mer : flot
  const coef = Math.min(1.5, Math.max(0.5, Math.abs(ev[k + 1][1] - ev[k][1]) / ps.meanRange));
  return { u: sign * Math.sin((Math.PI * (t - slack(k))) / span), coef, nextSlack: slack(k + 1) };
}

export interface Current { speed: number; dir: number; flood: boolean; nextSlack: number }

export function currentAt(p: CurrentPoint, tides: Tides, t: number): Current | null {
  const [, , floodDir, vmax, s1, s2, w1] = p;
  const ps = pseudoStation(tides, s1, s2, w1);
  const ph = ps && phase(ps, t);
  if (!ph) return null;
  const u = ph.u * ph.coef;
  return { speed: vmax * Math.abs(u), dir: u >= 0 ? floodDir : (floodDir + 180) % 360, flood: u >= 0, nextSlack: ph.nextSlack };
}

/** Point de grille le plus proche (dans `maxKm`), pour le bandeau. */
// Grille d'environ 900 m : au-delà de 0,7 km du point le plus proche, on n'est pas en eau à marée estimée
export function nearestPoint(grid: CurrentGrid, lat: number, lon: number, maxKm = 0.7): CurrentPoint | null {
  let best: CurrentPoint | null = null, bd = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (const p of grid.points) {
    const d = (p[0] - lat) ** 2 + ((p[1] - lon) * k) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best && Math.sqrt(bd) * 111 <= maxKm ? best : null;
}

/** Prochaines pleine et basse mers à la station la plus proche, si elle est à moins de `maxKm`
 * (au-delà, l'heure de la marée peut différer de plus d'une demi-heure : côte belge, large). */
export function nextTides(tides: Tides, lat: number, lon: number, t: number, maxKm = 30): { station: string; km: number; datum: 'NAP' | 'ZC'; hw?: TideEvent; lw?: TideEvent } | null {
  const k = Math.cos((lat * Math.PI) / 180);
  const st = Object.values(tides.stations).reduce<TideStation | null>((a, s) =>
    !a || (s.lat - lat) ** 2 + ((s.lon - lon) * k) ** 2 < (a.lat - lat) ** 2 + ((a.lon - lon) * k) ** 2 ? s : a, null);
  if (!st) return null;
  const km = Math.hypot(st.lat - lat, (st.lon - lon) * k) * 111;
  if (km > maxKm) return null;
  const next = st.events.filter((e) => e[0] > t);
  return { station: st.name, km, datum: st.datum ?? 'NAP', hw: next.find((e) => e[2] === 'H'), lw: next.find((e) => e[2] === 'L') };
}

/** Courants répartis sur l'écran : par case de `spacing` px, le point du chenal (vitesse max la plus forte). */
export function currentScreenFeatures(
  grid: CurrentGrid, tides: Tides, t: number, width: number, height: number, spacing: number,
  project: (lon: number, lat: number) => { x: number; y: number },
): GeoJSON.FeatureCollection {
  const best = new Map<string, CurrentPoint>();
  for (const p of grid.points) {
    const { x, y } = project(p[1], p[0]);
    if (x < 0 || y < 0 || x > width || y > height) continue;
    const cell = `${Math.floor(x / spacing)},${Math.floor(y / spacing)}`;
    const cur = best.get(cell);
    if (!cur || p[3] > cur[3]) best.set(cell, p);
  }
  const features: GeoJSON.Feature[] = [];
  for (const p of best.values()) {
    const c = currentAt(p, tides, t);
    if (!c) continue;
    features.push({
      type: 'Feature',
      properties: { speed: Math.round(c.speed * 10) / 10, to: Math.round(c.dir) },
      geometry: { type: 'Point', coordinates: [p[1], p[0]] },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------- mer du Nord : prévision du modèle SMOC (pipeline/src/seacurrents.py) ----------
// Au large, le courant tourne environ 3 h après la pleine mer (marée qui se propage le long de la côte) :
// le modèle d'atlas ci-dessus ne s'y applique pas. Courant total (marée + vent), maille ~8 km.

export interface SeaCurrents {
  generated: number;
  times: number[];                    // heures (ms, UTC)
  points: [number, number][];         // [lat, lon]
  speed_dkn: (number | null)[][];     // dixièmes de nœud, par point puis par heure
  dir: (number | null)[][];           // direction vers laquelle porte le courant (°)
}
export interface SeaCurrent { speed: number; dir: number }

/** Courant du modèle au point `i` à l'instant `t` (interpolation linéaire en composantes entre deux heures). */
export function seaCurrentAt(sc: SeaCurrents, i: number, t: number): SeaCurrent | null {
  const ts = sc.times;
  if (ts.length < 2 || t < ts[0] || t > ts.at(-1)!) return null; // hors période : rien plutôt qu'une autre heure
  const step = ts[1] - ts[0];
  const k = Math.min(Math.floor((t - ts[0]) / step), ts.length - 2);
  const f = (t - ts[k]) / step;
  let u = 0, v = 0;
  for (const [h, w] of [[k, 1 - f], [k + 1, f]] as const) {
    const s = sc.speed_dkn[i][h], d = sc.dir[i][h];
    if (s == null || d == null) return null;
    const r = (d * Math.PI) / 180;
    u += (w * s * Math.sin(r)) / 10;
    v += (w * s * Math.cos(r)) / 10;
  }
  return { speed: Math.hypot(u, v), dir: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360 };
}

/**
 * Courant du modèle en un point quelconque : moyenne des mailles à moins de `maxKm` pondérée par l'inverse
 * du carré de la distance, en composantes (les mailles sont espacées de ~8 km, la vue en navigation de 2 à 5 km).
 */
export function seaCurrentNear(sc: SeaCurrents, lat: number, lon: number, t: number, maxKm = 6): SeaCurrent | null {
  const k = Math.cos((lat * Math.PI) / 180);
  let u = 0, v = 0, wsum = 0;
  sc.points.forEach(([plat, plon], i) => {
    const km = Math.hypot(plat - lat, (plon - lon) * k) * 111;
    if (km > maxKm) return;
    const c = seaCurrentAt(sc, i, t);
    if (!c) return;
    const w = 1 / Math.max(km, 0.2) ** 2;
    const r = (c.dir * Math.PI) / 180;
    u += w * c.speed * Math.sin(r);
    v += w * c.speed * Math.cos(r);
    wsum += w;
  });
  if (wsum === 0) return null;
  u /= wsum; v /= wsum;
  return { speed: Math.hypot(u, v), dir: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360 };
}

/** Flèches du modèle réparties sur l'écran (tous les `spacing` px), là où `accept` reconnaît l'eau du large. */
export function seaScreenFeatures(
  sc: SeaCurrents, t: number, width: number, height: number, spacing: number,
  unproject: (x: number, y: number) => { lng: number; lat: number }, accept: (x: number, y: number) => boolean,
): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  for (let y = spacing / 2; y < height; y += spacing) {
    for (let x = spacing / 2; x < width; x += spacing) {
      const { lng, lat } = unproject(x, y);
      const c = seaCurrentNear(sc, lat, lng, t);
      if (!c || !accept(x, y)) continue;
      features.push({
        type: 'Feature',
        properties: { speed: Math.round(c.speed * 10) / 10, to: Math.round(c.dir), model: true },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      });
    }
  }
  return features;
}

/** Échelle de couleur du courant (nœuds), distincte de celle du vent. */
export const CURRENT_SCALE: [number, string][] = [[0, '#8a9aa8'], [0.3, '#4fb3d9'], [1, '#1f6fd0'], [2, '#5b3fd0'], [3, '#b0179b']];
export const CURRENT_SCALE_NIGHT: [number, string][] = [[0, '#40484f'], [0.3, '#2f5a6a'], [1, '#2a3f6a'], [2, '#3f2f6a'], [3, '#5a2a55']];
export const currentColourFor = (kn: number, night = false) =>
  (night ? CURRENT_SCALE_NIGHT : CURRENT_SCALE).reduce((c, [min, col]) => (kn >= min ? col : c), CURRENT_SCALE[0][1]);
