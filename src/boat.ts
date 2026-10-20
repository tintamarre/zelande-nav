// Position du bateau : suivi GPS, calcul du cap et de la vitesse fond (COG/SOG).
import { bearingDeg, distanceM } from './track';

export interface Fix {
  lat: number;
  lon: number;
  acc: number;          // précision horizontale (m)
  sog: number;          // nœuds
  cog: number | null;   // degrés vrais, null à l'arrêt
  t: number;
}

const KN = 1.943844; // m/s → nœuds
const MIN_SPEED_KN = 0.4; // en dessous : cap non significatif
const MAX_ACC_M = 30;     // au-delà (localisation réseau/wifi) : pas de vitesse calculée entre positions
const MAX_SPEED_KN = 40;  // au-delà : valeur aberrante pour un voilier, ignorée

/** Résumé d'une position brute reçue, pour le diagnostic GPS. */
export interface RawFix { t: number; acc: number; alt: boolean; speed: boolean }

export class Boat {
  private watchId: number | null = null;
  readonly history: RawFix[] = [];
  private prev: Fix | null = null;
  last: Fix | null = null;

  constructor(private onFix: (f: Fix) => void, private onError: (msg: string) => void) {}

  get active() { return this.watchId !== null; }

  start() {
    if (this.watchId !== null) return;
    if (!('geolocation' in navigator)) return this.onError('GPS indisponible sur cet appareil');
    this.last = this.prev = null; // ne pas réutiliser la position d'une session précédente
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.update(p),
      (e) => this.onError(e.code === e.PERMISSION_DENIED ? 'Accès à la position refusé' : 'Position indisponible'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  private update(p: GeolocationPosition) {
    const { latitude: lat, longitude: lon, accuracy: acc, speed, heading } = p.coords;
    const t = p.timestamp;
    // Une altitude est fournie par un fix satellite, pas par une position réseau/antenne
    this.history.unshift({ t, acc, alt: p.coords.altitude != null, speed: speed != null && !Number.isNaN(speed) });
    this.history.length = Math.min(this.history.length, 12);
    let sog: number;
    let cog: number | null;
    if (speed != null && !Number.isNaN(speed)) {
      sog = speed * KN;
      cog = heading != null && !Number.isNaN(heading) ? heading : null;
    } else if (this.prev && t - this.prev.t >= 1000 && acc <= MAX_ACC_M && this.prev.acc <= MAX_ACC_M) {
      // Pas de vitesse fournie (certains navigateurs) : dérivée des deux dernières positions précises
      const d = distanceM(this.prev, { lat, lon });
      sog = (d / ((t - this.prev.t) / 1000)) * KN;
      cog = d > Math.max(2, acc / 2) ? bearingDeg(this.prev, { lat, lon }) : null;
    } else {
      // Position imprécise (±1 km en localisation réseau) : vitesse et cap inconnus
      sog = 0;
      cog = null;
    }
    if (sog > MAX_SPEED_KN) {
      sog = this.last?.sog ?? 0;
      cog = this.last?.cog ?? null;
    }
    // Lissage léger (moyenne exponentielle ; circulaire pour le cap)
    if (this.last) {
      sog = 0.6 * sog + 0.4 * this.last.sog;
      if (cog != null && this.last.cog != null) {
        const r = Math.PI / 180;
        const x = 0.6 * Math.cos(cog * r) + 0.4 * Math.cos(this.last.cog * r);
        const y = 0.6 * Math.sin(cog * r) + 0.4 * Math.sin(this.last.cog * r);
        cog = (Math.atan2(y, x) / r + 360) % 360;
      }
    }
    if (sog < MIN_SPEED_KN) cog = null;
    const fix = { lat, lon, acc, sog, cog, t };
    this.prev = { ...fix };
    this.last = fix;
    this.onFix(fix);
  }
}

/** 51°32.123'N 3°45.678'E */
export function formatLatLon(lat: number, lon: number): string {
  const f = (v: number, pos: string, neg: string, w: number) => {
    const a = Math.abs(v);
    const deg = Math.floor(a);
    const min = (a - deg) * 60;
    return `${String(deg).padStart(w, '0')}°${min.toFixed(3).padStart(6, '0')}′${v >= 0 ? pos : neg}`;
  };
  return `${f(lat, 'N', 'S', 2)} ${f(lon, 'E', 'W', 3)}`;
}
