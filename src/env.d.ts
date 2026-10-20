/// <reference types="vite/client" />
declare const __APP_VERSION__: string;
interface ImportMetaEnv {
  /** URL du dossier des données : zeeland.pmtiles, zeeland.json, tides.json, currents.json (défaut : « tiles/ » à côté de l'app) */
  readonly VITE_CHART_BASE?: string;
}
