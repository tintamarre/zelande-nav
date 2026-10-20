// Carte Zélande : lecture en ligne (requêtes HTTP Range sur le .pmtiles) ou hors-ligne
// (fichier complet téléchargé une fois dans le Cache Storage, lu par tranches via Blob.slice).
import { FetchSource, PMTiles, type RangeResponse, type Source } from 'pmtiles';

export interface Manifest {
  file: string;
  bytes: number;
  sha256_16: string;
  edition_date: string | null;
  edition_title: string | null;
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
}

const CHART_BASE = new URL(import.meta.env.VITE_CHART_BASE ?? 'tiles/', new URL(import.meta.env.BASE_URL, location.href)).href;
const MANIFEST_URL = `${CHART_BASE}zeeland.json`;
const CACHE = 'zn-charts-v1';
const OFFLINE_KEY = 'zn.offlineManifest';

class BlobSource implements Source {
  constructor(private blob: Blob, private key: string) {}
  getKey() { return this.key; }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: await this.blob.slice(offset, offset + length).arrayBuffer() };
  }
}

export function offlineManifest(): Manifest | null {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

/** Manifeste publié (null hors connexion). */
export async function remoteManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const offlineUrl = (m: Manifest) => `${CHART_BASE}${m.file}?v=${m.sha256_16}`;

/** Ouvre la carte : la copie locale si elle existe, sinon le fichier en ligne. */
export async function openChart(remote: Manifest | null): Promise<{ pm: PMTiles; manifest: Manifest; offline: boolean } | null> {
  const local = offlineManifest();
  if (local && 'caches' in window) {
    const res = await (await caches.open(CACHE)).match(offlineUrl(local));
    if (res) {
      const blob = await res.blob();
      return { pm: new PMTiles(new BlobSource(blob, `offline-${local.sha256_16}`)), manifest: local, offline: true };
    }
  }
  if (!remote) return null;
  const url = `${CHART_BASE}${remote.file}?v=${remote.sha256_16}`;
  return { pm: new PMTiles(new FetchSource(url)), manifest: remote, offline: false };
}

/** Télécharge le .pmtiles complet dans le cache local, avec progression (0 → 1). */
export async function downloadChart(m: Manifest, onProgress: (f: number) => void): Promise<void> {
  const url = offlineUrl(m);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`téléchargement impossible (${res.status})`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / m.bytes);
  }
  const blob = new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
  if (blob.size !== m.bytes) throw new Error(`fichier incomplet (${blob.size} / ${m.bytes} octets)`);
  await navigator.storage?.persist?.(); // demande au navigateur de ne pas purger la carte
  const cache = await caches.open(CACHE);
  for (const k of await cache.keys()) await cache.delete(k); // une seule édition gardée
  await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.size) } }));
  localStorage.setItem(OFFLINE_KEY, JSON.stringify(m));
}

export async function deleteOfflineChart() {
  await caches.delete(CACHE);
  localStorage.removeItem(OFFLINE_KEY);
}

export function formatEdition(m: Manifest | null): string {
  if (!m?.edition_date) return 'édition inconnue';
  const d = new Date(m.edition_date);
  const week = m.edition_title?.match(/Week\s*(\d+)/i)?.[1];
  return `RWS ${d.toLocaleDateString('fr-BE')}${week ? ` (sem. ${week})` : ''}`;
}
