// Enregistrement de trace (IndexedDB) et export GPX.

export interface TrackPoint { t: number; lat: number; lon: number; sog?: number; cog?: number }
export interface Track { id: number; name: string; points: TrackPoint[] }

const DB = 'zn-tracks';
const STORE = 'tracks';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const saveTrack = (t: Track) => tx('readwrite', (s) => s.put(t));
export const listTracks = () => tx<Track[]>('readonly', (s) => s.getAll() as IDBRequest<Track[]>);
export const deleteTrack = (id: number) => tx('readwrite', (s) => s.delete(id));

export function toGpx(t: Track): string {
  const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
  const pts = t.points
    .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Zélande Nav" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(t.name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

/** Partage (mobile) ou téléchargement (ordinateur) du fichier GPX. */
export async function exportGpx(t: Track) {
  const name = `${t.name.replace(/[^\w-]+/g, '_')}.gpx`;
  const file = new File([toGpx(t)], name, { type: 'application/gpx+xml' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: t.name });
      return;
    } catch {
      /* partage annulé : on retombe sur le téléchargement */
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Distance totale en milles nautiques. */
export function trackNm(points: TrackPoint[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += distanceM(points[i - 1], points[i]);
  return d / 1852;
}

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Point atteint en partant de `p` sur le cap `brg` (°) après `dist` mètres. */
export function destination(p: { lat: number; lon: number }, brg: number, dist: number): { lat: number; lon: number } {
  const R = 6371008.8, rad = Math.PI / 180, d = dist / R, b = brg * rad, la = p.lat * rad, lo = p.lon * rad;
  const lat2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lon2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat2));
  return { lat: lat2 / rad, lon: lon2 / rad };
}
