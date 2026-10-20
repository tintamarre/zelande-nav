import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol, type PMTiles } from 'pmtiles';
import { registerSW } from 'virtual:pwa-register';
import './ui.css';
import { Boat, type Fix, formatLatLon } from './boat';
import { deleteOfflineChart, downloadChart, formatEdition, type Manifest, offlineManifest, openChart, remoteManifest } from './chart';
import { describe, type Props } from './s57';
import { type Settings, loadSettings, safetyContour, safetyDepth, saveSettings } from './settings';
import { buildStyle } from './style';
import { compass, loadWind, nearestHour, type WindForecast, windGeoJSON } from './weather';
import { registerSymbols } from './symbols';
import { type Track, type TrackPoint, deleteTrack, destination, exportGpx, listTracks, saveTrack, trackNm } from './track';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const GLYPHS = new URL('fonts/', new URL(import.meta.env.BASE_URL, location.href)).href;
const ZEELAND: [number, number, number, number] = [3.13, 51.2, 4.5, 51.83];

let settings = loadSettings();
let remote: Manifest | null = null;
let current: { pm: PMTiles; manifest: Manifest; offline: boolean } | null = null;
let sourceUrl = '';
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

registerSW({ immediate: true });

// ---------- carte ----------
const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#cfd3d6' } }] },
  bounds: ZEELAND,
  fitBoundsOptions: { padding: 20 },
  maxBounds: [[1.5, 50.6], [6, 52.5]],
  minZoom: 7,
  maxZoom: 19,
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');
registerSymbols(map);

function applyStyle() {
  document.documentElement.dataset.theme = settings.night ? 'night' : 'day';
  if (!sourceUrl) return;
  map.setStyle(buildStyle(settings, sourceUrl, GLYPHS), { diff: true });
  // Les données GeoJSON (bateau, trace) sont remises après un changement de style
  map.once('styledata', () => { renderTrack(); renderWind(); if (boat.last) renderBoat(boat.last); });
  updateWind();
}

// ---------- couche vent ----------
let wind: WindForecast | null = null;
let windHour = -1;
const timeRange = $<HTMLInputElement>('time-range');

async function updateWind(force = false) {
  $('timebar').hidden = !settings.windLayer;
  if (!settings.windLayer) return;
  const fc = await loadWind(force);
  if (!fc) { toast('Prévision de vent indisponible (pas de connexion ni de prévision gardée).'); return; }
  const fresh = fc !== wind;
  wind = fc;
  timeRange.max = String(fc.times.length - 1);
  if (fresh || windHour < 0) windHour = nearestHour(fc, Date.now());
  timeRange.value = String(windHour);
  renderWind();
}

function renderWind() {
  const src = map.getSource('wind') as GeoJSONSource | undefined;
  if (!src || !wind || windHour < 0) return;
  src.setData(windGeoJSON(wind, windHour));
  const t = new Date(wind.times[windHour]);
  const day = t.toLocaleDateString('fr-BE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const hour = t.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
  const age = Math.round((Date.now() - wind.fetched) / 3600_000);
  // Vent au centre de la carte (point de grille le plus proche)
  const c = map.getCenter();
  const near = wind.points.reduce((a, b) => (Math.hypot(b.lat - c.lat, b.lon - c.lng) < Math.hypot(a.lat - c.lat, a.lon - c.lng) ? b : a));
  $('time-label').textContent = `Vent ${day} ${hour} · centre : ${near.speed[windHour]} kn ${compass(near.dir[windHour])}, rafales ${near.gust[windHour]} kn · prévision KNMI${age >= 1 ? ` d’il y a ${age} h` : ''}`;
}
timeRange.addEventListener('input', () => { windHour = Number(timeRange.value); renderWind(); });
map.on('moveend', () => { if (settings.windLayer) renderWind(); });
setInterval(() => { if (settings.windLayer) updateWind(); }, 3600_000);

async function loadChart() {
  remote = await remoteManifest();
  current = await openChart(remote);
  if (!current) {
    $('edition').textContent = 'carte indisponible hors connexion : téléchargez-la une fois en ligne';
    toast('Pas de carte : connectez-vous pour la télécharger.');
    return;
  }
  protocol.add(current.pm);
  sourceUrl = `pmtiles://${current.pm.source.getKey()}`;
  applyStyle();
  updateEditionUi();
  if (current.offline && remote && remote.sha256_16 !== current.manifest.sha256_16) {
    toast(`Nouvelle édition disponible (${formatEdition(remote)}) : mettez à jour la carte hors-ligne.`, 8000);
    $('chart-btn').classList.remove('ok');
  }
}

function updateEditionUi() {
  const m = current?.manifest ?? null;
  $('edition').textContent = formatEdition(m);
  $('about-edition').textContent = formatEdition(m);
  $('offline-badge').hidden = !current?.offline;
  $('chart-btn').classList.toggle('ok', !!current?.offline);
}

// ---------- identification au tap ----------
const QUERY_LAYERS = ['buoys', 'beacons', 'lights', 'topmar', 'dangers', 'notmrk', 'harbour', 'bridge-line', 'bridge-fill',
  'cblohd', 'clearance', 'areas', 'soundg', 'soundg-drying', 'depare'];

map.on('click', (e) => {
  const r = 12;
  const layers = QUERY_LAYERS.filter((l) => map.getLayer(l));
  const feats = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers });
  if (!feats.length) return;
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const f of sortFeatures(feats)) {
    const p = f.properties as Props;
    const key = `${p.objl}|${p.OBJNAM ?? ''}|${p.DRVAL1 ?? ''}|${p.depth ?? ''}|${p.LITCHR ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { title, rows } = describe({ ...p, objl: p.objl ?? (f.sourceLayer === 'soundg' ? 'SOUNDG' : undefined) });
    blocks.push(`<h3>${esc(title)}</h3>${rows.length ? `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}`);
    if (blocks.length >= 6) break;
  }
  new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(e.lngLat).setHTML(`<div class="ident">${blocks.join('')}</div>`).addTo(map);
});

// Balisage et dangers d'abord, zones de profondeur en dernier
function sortFeatures(feats: MapGeoJSONFeature[]) {
  const rank = (f: MapGeoJSONFeature) => {
    const i = QUERY_LAYERS.indexOf(f.layer.id);
    return i < 0 ? 99 : i;
  };
  return [...feats].sort((a, b) => rank(a) - rank(b));
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

// ---------- bateau ----------
let following = false;
let recording: Track | null = null;
let alarmAcked = false;
let wakeLock: WakeLockSentinel | null = null;

const boat = new Boat(onFix, (msg) => { toast(msg); setLocateUi(); });

function onFix(f: Fix) {
  renderBoat(f);
  $('instruments').hidden = false;
  $('sog').textContent = f.sog.toFixed(1);
  $('cog').textContent = f.cog == null ? '–' : String(Math.round(f.cog)).padStart(3, '0');
  $('pos').textContent = `${formatLatLon(f.lat, f.lon)} ±${Math.round(f.acc)} m${f.acc > 30 ? ' · GPS imprécis' : ''}`;
  if (following) map.easeTo({ center: [f.lon, f.lat], duration: 600 });
  if (recording) recordPoint(f);
  // Le contrôle hauts-fonds interroge les objets rendus : attendre la fin du déplacement de la carte
  if (following) map.once('idle', () => checkShallows(f)); else checkShallows(f);
}

function renderBoat(f: Fix) {
  const src = map.getSource('boat') as GeoJSONSource | undefined;
  if (!src) return;
  const features: GeoJSON.Feature[] = [
    { type: 'Feature', properties: { cog: f.cog ?? 0, acc: f.acc }, geometry: { type: 'Point', coordinates: [f.lon, f.lat] } },
  ];
  if (f.cog != null && f.sog > 0.4) {
    const ahead = destination(f, f.cog, (f.sog * 1852 * settings.lookAheadMin) / 60);
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[f.lon, f.lat], [ahead.lon, ahead.lat]] } });
  }
  src.setData({ type: 'FeatureCollection', features });
}

/** Alarme si la position, ou le vecteur d'anticipation, entre dans une zone moins profonde que le contour de sécurité. */
function checkShallows(f: Fix) {
  if (!map.getLayer('depare')) return;
  if (!map.isStyleLoaded()) { map.once('idle', () => checkShallows(f)); return; } // style en cours de rechargement
  const safety = safetyDepth(settings);
  const pts = [{ lat: f.lat, lon: f.lon }];
  if (f.cog != null && f.sog > 0.4 && settings.lookAheadMin > 0) {
    const dist = (f.sog * 1852 * settings.lookAheadMin) / 60;
    for (let i = 1; i <= 6; i++) pts.push(destination(f, f.cog, (dist * i) / 6));
  }
  const canvas = map.getCanvas();
  let hereMin: number | null = null;
  let hereMax: number | null = null;
  let danger: string | null = null;
  pts.forEach((p, i) => {
    const px = map.project([p.lon, p.lat]);
    if (px.x < 0 || px.y < 0 || px.x > canvas.clientWidth || px.y > canvas.clientHeight) return;
    const areas = map.queryRenderedFeatures(px, { layers: ['depare'] });
    const d1 = areas.map((a) => Number(a.properties.DRVAL1)).filter((v) => !Number.isNaN(v));
    if (i === 0 && d1.length) {
      hereMin = Math.min(...d1);
      hereMax = Math.max(...areas.map((a) => Number(a.properties.DRVAL2)).filter((v) => !Number.isNaN(v)));
    }
    if (!danger && d1.length && Math.min(...d1) < safety) {
      danger = i === 0 ? `Haut-fond sous le bateau (${depthText(Math.min(...d1))})` : `Haut-fond droit devant (${depthText(Math.min(...d1))}, < ${settings.lookAheadMin} min)`;
    }
    if (!danger && map.getLayer('dangers')) {
      const near = map.queryRenderedFeatures([[px.x - 10, px.y - 10], [px.x + 10, px.y + 10]], { layers: ['dangers'] });
      const hit = near.find((n) => n.properties.VALSOU != null && Number(n.properties.VALSOU) <= safety);
      if (hit) danger = `Danger isolé ${i === 0 ? 'à proximité' : 'droit devant'} (${depthText(Number(hit.properties.VALSOU))})`;
    }
  });
  $('depth').textContent = hereMin == null ? '–'
    : hereMax != null && hereMax <= 0 ? 'estran'
    : hereMax != null && Number.isFinite(hereMax) ? `${fmt(Math.max(0, hereMin))}–${fmt(hereMax)}` : fmt(hereMin);
  $('instruments').classList.toggle('shallow', hereMin != null && hereMin < safety);
  setAlarm(danger);
}

const fmt = (v: number) => v.toLocaleString('fr-BE');
// Profondeur négative = hauteur découvrante (au-dessus du zéro des cartes)
const depthText = (v: number) => (v < 0 ? `découvre jusqu’à ${fmt(-v)} m` : `${fmt(v)} m`);

let audio: AudioContext | null = null;
function setAlarm(msg: string | null) {
  const el = $('alarm');
  if (!msg) {
    el.hidden = true;
    alarmAcked = false;
    return;
  }
  $('alarm-text').textContent = msg;
  if (alarmAcked) return;
  const wasHidden = el.hidden;
  el.hidden = false;
  if (wasHidden) {
    navigator.vibrate?.([300, 120, 300]);
    try {
      audio ??= new AudioContext();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.2;
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + 0.5);
    } catch { /* audio indisponible */ }
  }
}
$('alarm-ack').onclick = () => { alarmAcked = true; $('alarm').hidden = true; };

// Bouton position : 1er appui = GPS + suivi ; appui suivant = suivi on/off ; appui long = arrêt du GPS
const locateBtn = $('locate-btn');
function setLocateUi() {
  locateBtn.classList.toggle('on', boat.active && !following);
  locateBtn.classList.toggle('following', boat.active && following);
}
locateBtn.onclick = async () => {
  if (!boat.active) {
    boat.start();
    following = true;
    await keepAwake(true);
    if (boat.last) map.easeTo({ center: [boat.last.lon, boat.last.lat], zoom: Math.max(map.getZoom(), 13) });
    toast('GPS activé. Appui long pour l’arrêter.');
  } else {
    following = !following;
    if (following && boat.last) map.easeTo({ center: [boat.last.lon, boat.last.lat] });
  }
  setLocateUi();
};
let pressTimer = 0;
locateBtn.addEventListener('pointerdown', () => {
  pressTimer = window.setTimeout(() => {
    boat.stop();
    following = false;
    keepAwake(!!recording);
    $('instruments').hidden = true;
    setAlarm(null);
    (map.getSource('boat') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
    setLocateUi();
    toast('GPS arrêté');
    pressTimer = -1;
  }, 800);
});
locateBtn.addEventListener('pointerup', (e) => {
  clearTimeout(pressTimer);
  if (pressTimer === -1) { e.preventDefault(); e.stopImmediatePropagation(); pressTimer = 0; }
}, true);
map.on('dragstart', () => { if (following) { following = false; setLocateUi(); } });

async function keepAwake(on: boolean) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* refusé (batterie faible, onglet masqué) */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (boat.active || recording)) { wakeLock = null; keepAwake(true); }
});

// ---------- trace ----------
let lastSaved = 0;
function recordPoint(f: Fix) {
  if (!recording) return;
  const prev = recording.points.at(-1);
  if (prev && f.t - prev.t < 5000) return; // 1 point / 5 s
  const p: TrackPoint = { t: f.t, lat: f.lat, lon: f.lon, sog: +f.sog.toFixed(2), cog: f.cog ?? undefined };
  recording.points.push(p);
  renderTrack();
  if (f.t - lastSaved > 30000) { saveTrack(recording); lastSaved = f.t; }
}

function renderTrack() {
  const src = map.getSource('track') as GeoJSONSource | undefined;
  if (!src) return;
  const coords = recording?.points.map((p) => [p.lon, p.lat]) ?? [];
  src.setData({ type: 'FeatureCollection', features: coords.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : [] });
}

async function toggleRecording() {
  if (recording) {
    await saveTrack(recording);
    toast(`Trace enregistrée : ${trackNm(recording.points).toFixed(1)} M`);
    recording = null;
    keepAwake(boat.active);
  } else {
    const now = new Date();
    recording = { id: now.getTime(), name: `Trace ${now.toLocaleString('fr-BE', { dateStyle: 'short', timeStyle: 'short' })}`, points: [] };
    if (!boat.active) { boat.start(); setLocateUi(); }
    keepAwake(true);
  }
  $('track-btn').classList.toggle('on', !!recording);
  renderTrack();
  refreshTracks();
}

async function refreshTracks() {
  $('track-toggle').textContent = recording ? 'Arrêter l’enregistrement' : 'Démarrer l’enregistrement';
  const list = $('track-list');
  list.innerHTML = '';
  const tracks = (await listTracks()).sort((a, b) => b.id - a.id);
  for (const t of tracks) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(t.name)}<br><small>${trackNm(t.points).toFixed(1)} M · ${t.points.length} pts</small></span>`;
    const gpx = Object.assign(document.createElement('button'), { type: 'button', textContent: 'GPX' });
    gpx.onclick = () => exportGpx(t);
    const del = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Suppr.', className: 'secondary' });
    del.onclick = async () => { if (confirm(`Supprimer « ${t.name} » ?`)) { await deleteTrack(t.id); refreshTracks(); } };
    const actions = document.createElement('span');
    actions.append(gpx, ' ', del);
    li.append(actions);
    list.append(li);
  }
  if (!tracks.length) list.innerHTML = '<li><small>Aucune trace enregistrée.</small></li>';
}

$('track-btn').onclick = () => { refreshTracks(); $<HTMLDialogElement>('track-dlg').showModal(); };
$('track-toggle').onclick = () => toggleRecording();

// ---------- réglages ----------
const settingsForm = $<HTMLDialogElement>('settings-dlg').querySelector('form')!;
function fillSettings() {
  for (const [k, v] of Object.entries(settings)) {
    const input = settingsForm.elements.namedItem(k) as HTMLInputElement | null;
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(v);
    else input.value = String(v);
  }
  $('safety-out').textContent = `${safetyDepth(settings).toLocaleString('fr-BE')} m`;
  $('contour-out').textContent = `${safetyContour(settings).toLocaleString('fr-BE')} m`;
}
settingsForm.addEventListener('change', () => {
  const next = { ...settings } as Record<string, number | boolean>;
  for (const k of Object.keys(settings)) {
    const input = settingsForm.elements.namedItem(k) as HTMLInputElement | null;
    if (!input) continue;
    if (input.type === 'checkbox') next[k] = input.checked;
    else if (input.value !== '' && Number.isFinite(Number(input.value))) next[k] = Number(input.value);
  }
  settings = next as unknown as Settings;
  saveSettings(settings);
  fillSettings();
  applyStyle();
  if (boat.last) map.once('idle', () => checkShallows(boat.last!));
});
$('settings-btn').onclick = () => { fillSettings(); $<HTMLDialogElement>('settings-dlg').showModal(); };
fillSettings();

// ---------- carte hors-ligne ----------
const mb = (b: number) => `${(b / 1e6).toFixed(0)} Mo`;
function refreshChartDialog() {
  const local = offlineManifest();
  const st = $('chart-status');
  const dl = $<HTMLButtonElement>('chart-download');
  const del = $<HTMLButtonElement>('chart-delete');
  del.disabled = !local;
  if (!remote) {
    st.textContent = local ? `Carte enregistrée : ${formatEdition(local)}. Hors connexion : pas de vérification de mise à jour.` : 'Hors connexion.';
    dl.disabled = true;
    return;
  }
  dl.disabled = false;
  if (!local) {
    st.textContent = `Carte Zélande, ${formatEdition(remote)}, ${mb(remote.bytes)}. Téléchargez-la (de préférence en wifi) pour l’utiliser sans réseau.`;
    dl.textContent = `Télécharger (${mb(remote.bytes)})`;
  } else if (local.sha256_16 !== remote.sha256_16) {
    st.textContent = `Carte enregistrée : ${formatEdition(local)}. Nouvelle édition disponible : ${formatEdition(remote)}.`;
    dl.textContent = `Mettre à jour (${mb(remote.bytes)})`;
  } else {
    st.textContent = `Carte enregistrée et à jour : ${formatEdition(local)} (${mb(local.bytes)}).`;
    dl.textContent = 'Retélécharger';
  }
}
$('chart-btn').onclick = async () => {
  remote = (await remoteManifest()) ?? remote;
  refreshChartDialog();
  $<HTMLDialogElement>('chart-dlg').showModal();
};
$('chart-download').onclick = async () => {
  if (!remote) return;
  const bar = $<HTMLProgressElement>('chart-progress');
  const btn = $<HTMLButtonElement>('chart-download');
  bar.hidden = false;
  btn.disabled = true;
  try {
    await downloadChart(remote, (f) => { bar.value = f; });
    await loadChart();
    toast('Carte disponible hors-ligne.');
  } catch (err) {
    toast(`Échec : ${(err as Error).message}`, 6000);
  } finally {
    bar.hidden = true;
    btn.disabled = false;
    refreshChartDialog();
  }
};
$('chart-delete').onclick = async () => {
  if (!confirm('Supprimer la carte hors-ligne de cet appareil ?')) return;
  await deleteOfflineChart();
  await loadChart();
  refreshChartDialog();
};

// ---------- divers ----------
$('about-btn').onclick = () => $<HTMLDialogElement>('about-dlg').showModal();
$('app-version').textContent = `Version ${__APP_VERSION__}`;

let toastTimer = 0;
function toast(msg: string, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, ms);
}

window.addEventListener('beforeunload', () => { if (recording) saveTrack(recording); });

loadChart();

// Accès console pour le débogage
Object.assign(window, { map });
