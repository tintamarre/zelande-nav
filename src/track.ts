// Enregistrement de trace et notes de bord (IndexedDB), export GPX et journal texte.

export interface TrackPoint { t: number; lat: number; lon: number; sog?: number; cog?: number }
export interface Track { id: number; name: string; points: TrackPoint[] }
/** Type de repère : une note qui reste sur la carte (mouillage, danger, info), au lieu d'une entrée du journal liée à une trace. */
export type MarkKind = 'anchor' | 'danger' | 'info';
export const MARK_LABEL: Record<MarkKind, string> = { anchor: 'Mouillage', danger: 'Danger', info: 'Info' };
/** Note de bord : instant et position pris à l'appui sur le bouton ; `approx` = centre de la carte (pas de GPS) ; `mark` = repère permanent. */
export interface Note { id: number; t: number; lat: number; lon: number; text: string; sog?: number; cog?: number; approx?: boolean; mark?: MarkKind }

const DB = 'zn-tracks';
type StoreName = 'tracks' | 'notes';

// Une seule connexion pour toute la session (au lieu d'une par opération)
let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2); // v2 : notes de bord
    req.onupgradeneeded = () => {
      for (const name of ['tracks', 'notes']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

/** Résout quand la transaction est validée (pas seulement la requête), pour que les écritures soient durables. */
async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error ?? req.error);
    t.onabort = () => reject(t.error ?? new Error('transaction annulée'));
  });
}

export const saveTrack = (t: Track) => tx('tracks', 'readwrite', (s) => s.put(t));
export const listTracks = () => tx<Track[]>('tracks', 'readonly', (s) => s.getAll() as IDBRequest<Track[]>);
export const deleteTrack = (id: number) => tx('tracks', 'readwrite', (s) => s.delete(id));

export const saveNote = (n: Note) => tx('notes', 'readwrite', (s) => s.put(n));
export const listNotes = async () => (await tx<Note[]>('notes', 'readonly', (s) => s.getAll() as IDBRequest<Note[]>)).sort((a, b) => a.t - b.t);
/** Une seule transaction : tout ou rien, même si la page est fermée pendant l'effacement. */
export async function deleteNotes(ids: number[]) {
  if (ids.length) await tx('notes', 'readwrite', (s) => ids.map((id) => s.delete(id)).at(-1)!);
}

/** Notes prises pendant la trace (de son premier à son dernier point). */
export const notesOf = (t: Track, notes: Note[]) =>
  t.points.length ? notes.filter((n) => n.t >= t.points[0].t && n.t <= t.points.at(-1)!.t) : [];

const xml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
export const firstLine = (s: string) => (s.split('\n')[0] || 'Note').slice(0, 40);
// Symboles GPX courants (Garmin, repris par OpenCPN et la plupart des applications)
const GPX_SYM: Record<MarkKind, string> = { anchor: 'Anchor', danger: 'Danger Area', info: 'Information' };

/** Notes en points de passage GPX (<wpt>) : épingles avec texte dans OpenCPN, Navionics, Google Earth… */
function gpxWaypoints(notes: Note[]): string {
  return notes.map((n) => `  <wpt lat="${n.lat.toFixed(6)}" lon="${n.lon.toFixed(6)}">
    <time>${new Date(n.t).toISOString()}</time>
    <name>${xml(firstLine(n.text))}</name>
    <desc>${xml(n.text + (n.approx ? '\n(position approximative : centre de la carte, sans GPS)' : ''))}</desc>
    <sym>${n.mark ? GPX_SYM[n.mark] : 'Flag'}</sym>${n.mark ? `\n    <type>${MARK_LABEL[n.mark]}</type>` : ''}
  </wpt>
`).join('');
}

function gpx(name: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Zélande Nav" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${xml(name)}</name></metadata>
${body}</gpx>
`;
}

export function toGpx(t: Track, notes: Note[] = []): string {
  const pts = t.points
    .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`)
    .join('\n');
  return gpx(t.name, `${gpxWaypoints(notes)}  <trk>
    <name>${xml(t.name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
`);
}

export const notesGpx = (notes: Note[], name = 'Journal de bord') => gpx(name, gpxWaypoints(notes));

/** Journal de bord en Markdown (texte brut lisible partout, mis en forme par Obsidian, Joplin, GitHub…) :
 *  un titre par jour, une entrée par note (heure, position, vitesse), puis les repères. */
export function notesMarkdown(notes: Note[], fmtPos: (lat: number, lon: number) => string): string {
  const out: string[] = ['# Journal de bord – Zélande Nav', ''];
  const pos = (n: Note) => `${fmtPos(n.lat, n.lon)}${n.approx ? ' (approx., sans GPS)' : ''}`;
  let day = '';
  for (const n of notes.filter((x) => !x.mark)) {
    const d = new Date(n.t);
    const dd = d.toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (dd !== day) { out.push(`## ${dd[0].toUpperCase()}${dd.slice(1)}`, ''); day = dd; }
    const hh = d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
    const nav = n.sog != null ? ` · ${n.sog.toFixed(1).replace('.', ',')} kn${n.cog != null ? ` au ${String(Math.round(n.cog)).padStart(3, '0')}°` : ''}` : '';
    out.push(`### ${hh} · ${pos(n)}${nav}`, '', n.text, '');
  }
  const marks = notes.filter((x) => x.mark);
  if (marks.length) {
    out.push('## Repères', '');
    for (const n of marks) {
      const d = new Date(n.t).toLocaleDateString('fr-BE', { dateStyle: 'short' });
      out.push(`### ${MARK_LABEL[n.mark!]} · ${pos(n)}`, '', n.text, '', `_Noté le ${d}_`, '');
    }
  }
  return out.join('\n');
}

/** Partage (mobile) ou téléchargement (ordinateur) d'un fichier. */
export async function shareFile(name: string, content: string, type: string, title: string) {
  const file = new File([content], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
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
