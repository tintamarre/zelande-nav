// Réglages du bateau et de l'affichage, mémorisés sur l'appareil.

export interface Settings {
  draft: number;        // tirant d'eau (m)
  margin: number;       // pied de pilote (m)
  airDraft: number;     // tirant d'air (m), pour les ponts et câbles aériens
  deepContour: number;  // au-delà : eau profonde (blanc)
  night: boolean;       // palette nuit (S-52 « night », atténuée)
  soundings: boolean;
  lookAheadMin: number; // anticipation de l'alarme hauts-fonds (minutes)
  windLayer: boolean;   // couche optionnelle : prévision de vent
  currentLayer: boolean; // couche optionnelle : courants de marée estimés
}

export const DEFAULTS: Settings = {
  draft: 1.5,
  margin: 0.5,
  airDraft: 14,
  deepContour: 5,
  night: false,
  soundings: true,
  lookAheadMin: 2,
  windLayer: false,
  currentLayer: false,
};

const KEY = 'zn.settings';

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* stockage indisponible (navigation privée) : réglages non mémorisés */
  }
}

/** Contour de sécurité = tirant d'eau + pied de pilote. */
export const safetyDepth = (s: Settings) => s.draft + s.margin;

/** Isobathe réellement tracée sur la carte qui sert de contour de sécurité (la première ≥ sécurité). */
export function safetyContour(s: Settings): number {
  const d = safetyDepth(s);
  const available = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 10, 20, 30];
  return available.find((v) => v >= d) ?? 30;
}
