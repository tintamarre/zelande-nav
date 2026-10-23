import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol, type PMTiles } from 'pmtiles';
import { registerSW } from 'virtual:pwa-register';
import './ui.css';
import { Boat, type Fix, formatLatLon } from './boat';
import { deleteOfflineChart, downloadChart, formatEdition, loadData, type Manifest, offlineManifest, openChart, remoteManifest } from './chart';
import { describe, type Props } from './s57';
import { type Settings, loadSettings, safetyContour, safetyDepth, saveSettings } from './settings';
import { buildStyle } from './style';
import { beaufort, compass, inForecast, loadWind, nearestHour, pointOfSail, type WindForecast, windAt, windColourFor, windScreenGrid } from './weather';
import { type CurrentGrid, currentAt, currentColourFor, currentScreenFeatures, nearestPoint, nextTides, type Tides } from './currents';
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

// Nouvelle version : proposée, jamais appliquée d'office (un rechargement couperait GPS, alarme et trace)
const updateSW = registerSW({ immediate: true, onNeedRefresh: () => { $('update-btn').hidden = false; } });

// ---------- carte ----------
const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#cfd3d6' } }] },
  bounds: ZEELAND,
  fitBoundsOptions: { padding: 20 },
  maxBounds: [[1.0, 50.5], [6, 52.8]], // resserrée sur l'emprise de la carte dès son chargement (loadChart)
  minZoom: 7,
  maxZoom: 19,
  attributionControl: false, // sources et mentions dans « À propos » (bouton ⓘ unique, en bas à droite)
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');
registerSymbols(map);

let styledSource = '';
function applyStyle() {
  document.documentElement.dataset.theme = settings.night ? 'night' : 'day';
  if (!sourceUrl) return;
  // Le mode diff de MapLibre ne sait pas remplacer une source utilisée par des couches :
  // rechargement complet quand la carte change (ex. passage en ligne → hors-ligne)
  map.setStyle(buildStyle(settings, sourceUrl, GLYPHS), { diff: sourceUrl === styledSource });
  styledSource = sourceUrl;
  // Les données GeoJSON (bateau, trace) sont remises après un changement de style
  map.once('styledata', () => { renderTrack(); renderLayers(); if (boat.active && boat.last) renderBoat(boat.last); });
}

// ---------- couches vent et courant : échelle de temps commune ----------
let wind: WindForecast | null = null;
let tides: Tides | null = null;
let currentGrid: CurrentGrid | null = null;
let live = true;      // « maintenant » : suit l'heure courante tant que le curseur n'a pas été déplacé
let fixedTime = 0;    // instant choisi au curseur (absolu : ne glisse pas au changement d'heure)
const toasted = new Set<string>();
const timeRange = $<HTMLInputElement>('time-range');
const hourNow = () => Math.floor(Date.now() / 3600_000) * 3600_000;
const viewTime = () => (live ? Date.now() : fixedTime);
const toastOnce = (key: string, msg: string) => { if (!toasted.has(key)) toast(msg, 6000); toasted.add(key); };

async function updateLayers(force = false) {
  for (const [btn, on] of [['wind-btn', settings.windLayer], ['current-btn', settings.currentLayer]] as const) {
    $(btn).classList.toggle('on', on);
    $(btn).setAttribute('aria-pressed', String(on));
  }
  $('envpanel').hidden = !settings.windLayer && !settings.currentLayer;
  $('wind-row').hidden = !settings.windLayer;
  $('current-row').hidden = !settings.currentLayer;
  // Vent et courants chargés en parallèle (indépendants)
  await Promise.all([
    settings.windLayer && (async () => {
      wind = (await loadWind(force)) ?? wind;
      if (!wind) toastOnce('wind', 'Prévision de vent indisponible (pas de connexion ni de prévision gardée).');
    })(),
    settings.currentLayer && (!tides || !currentGrid || force) && (async () => {
      const [t, g] = await Promise.all([loadData<Tides>('tides.json'), loadData<CurrentGrid>('currents.json')]);
      tides = t ?? tides;
      currentGrid = g ?? currentGrid;
      if (!tides || !currentGrid) toastOnce('current', 'Courants indisponibles : ouvrez l’app une fois avec une connexion.');
    })(),
  ]);
  renderLayers();
}

/** Flèches recalculées pour la vue et l'heure affichées : visibles à tout zoom. */
function renderLayers() {
  const t = viewTime();
  const cv = map.getCanvas();
  if (settings.windLayer && wind) {
    // Hors de la période de prévision : pas de flèches (jamais celles d'une autre heure)
    (map.getSource('wind') as GeoJSONSource | undefined)?.setData(windInRange(wind, t)
      ? windScreenGrid(wind, nearestHour(wind, t), cv.clientWidth, cv.clientHeight, 85, (x, y) => map.unproject([x, y]))
      : { type: 'FeatureCollection', features: [] });
  }
  if (settings.currentLayer && tides && currentGrid) {
    (map.getSource('current') as GeoJSONSource | undefined)
      ?.setData(currentScreenFeatures(currentGrid, tides, t, cv.clientWidth, cv.clientHeight, 70, (lon, lat) => map.project([lon, lat])));
  }
  // curseur : position de l'instant affiché par rapport à l'heure ronde courante
  timeRange.value = String(live ? 0 : Math.round((fixedTime - hourNow()) / 3600_000));
  renderPanel();
}

const windInRange = (fc: WindForecast, t: number) => t >= fc.times[0] - 1800_000 && t <= fc.times.at(-1)! + 1800_000;

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(viewTime()).toDateString() ? hm : `${d.toLocaleDateString('fr-BE', { weekday: 'short' })} ${hm}`;
};

/** Bandeau : vent et courant au bateau (GPS actif) ou au centre de la carte. */
function renderPanel() {
  if (!settings.windLayer && !settings.currentLayer) return;
  const t = viewTime();
  const c = map.getCenter();
  const atBoat = boat.active && boat.last != null;
  const here = atBoat ? { lat: boat.last!.lat, lon: boat.last!.lon } : { lat: c.lat, lon: c.lng };
  const where = atBoat ? 'au bateau' : 'au centre';

  if (settings.windLayer) {
    const h = wind ? nearestHour(wind, t) : -1;
    const inRange = !!wind && windInRange(wind, t);
    const w = wind && inRange && inForecast(wind, here.lat, here.lon) ? windAt(wind, h, here.lat, here.lon) : null;
    if (!w) {
      $('wind-main').textContent = !wind ? 'Vent : pas de prévision' : !inRange ? 'Vent : hors période de prévision' : 'Vent : hors zone de prévision';
      $('wind-sub').textContent = '';
    } else {
      const kn = Math.round(w.speed);
      const later = h + 3 < wind!.times.length ? windAt(wind!, h + 3, here.lat, here.lon) : null;
      const k3 = later ? Math.round(later.speed) : null;
      const trend = k3 == null ? '' : k3 - kn >= 3 ? `, forcit (${k3} kn dans 3 h)` : kn - k3 >= 3 ? `, mollit (${k3} kn dans 3 h)` : ', stable sur 3 h';
      const sail = atBoat && boat.last!.cog != null ? ` · ${pointOfSail(w.dir, boat.last!.cog)}` : '';
      $('wind-main').textContent = `Vent ${kn} kn ${compass(w.dir)} · rafales ${Math.round(w.gust)} · F${beaufort(kn)}`;
      $('wind-sub').textContent = `${where}${trend}${sail}`;
      $('wind-needle').style.transform = `rotate(${(w.dir + 180) % 360}deg)`;
      $('wind-row').style.setProperty('--needle', windColourFor(kn, settings.night));
    }
    $('wind-dial').style.visibility = w ? 'visible' : 'hidden';
  }

  if (settings.currentLayer) {
    const p = tides && currentGrid ? nearestPoint(currentGrid, here.lat, here.lon) : null;
    const cur = p ? currentAt(p, tides!, t) : null;
    // Marée : à la station la plus proche, aussi là où il n'y a pas d'estimation de courant (mer du Nord)
    const nt = tides ? nextTides(tides, here.lat, here.lon, t) : null;
    $('current-main').textContent = !tides || !currentGrid ? 'Courant : données indisponibles'
      : cur ? `Courant ${cur.speed.toFixed(1).replace('.', ',')} kn vers ${String(Math.round(cur.dir)).padStart(3, '0')}° · ${cur.flood ? 'flot' : 'jusant'}`
      : p ? 'Courant : hors période des marées' : 'Courant : pas d’estimation ici (estimé en Zélande seulement)';
    const parts = [
      cur ? `étale vers ${fmtTime(cur.nextSlack)}` : '',
      // hauteurs en m NAP (≠ zéro des cartes, environ 2 à 2,5 m plus bas) : précisé pour ne pas les additionner aux sondes
      nt?.hw && nt.lw ? `PM ${fmtTime(nt.hw[0])} (${fmt(nt.hw[1])} m NAP), BM ${fmtTime(nt.lw[0])} (${fmt(nt.lw[1])} m NAP) à ${nt.station}${nt.km >= 8 ? ` (${Math.round(nt.km)} km)` : ''}`
        : tides && !nt ? 'marée : pas de station Rijkswaterstaat à moins de 30 km' : '',
      cur ? `${where}, estimation indicative` : '',
    ].filter(Boolean);
    $('current-sub').textContent = parts.join(' · ');
    $('current-dial').style.visibility = cur ? 'visible' : 'hidden';
    if (cur) {
      $('current-needle').style.transform = `rotate(${cur.dir}deg)`;
      $('current-row').style.setProperty('--needle', currentColourFor(cur.speed, settings.night));
    }
  }

  const d = new Date(t);
  const age = wind ? Math.round((Date.now() - wind.fetched) / 3600_000) : 0;
  const srcs = [settings.windLayer ? `vent KNMI${age >= 1 ? ` d’il y a ${age} h` : ''}` : '', settings.currentLayer ? 'marée RWS, courant estimé' : ''].filter(Boolean).join(', ');
  const hm = d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
  const day = d.toLocaleDateString('fr-BE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const offH = live ? 0 : Math.round((fixedTime - hourNow()) / 3600_000); // même référence que le curseur
  const tm = $('time-main');
  tm.classList.toggle('future', !live);
  const sub = document.createElement('small');
  sub.textContent = `${day} · ${live ? 'maintenant' : `${offH > 0 ? '+' : offH < 0 ? '−' : ''}${Math.abs(offH)} h`}`;
  tm.replaceChildren(hm, sub);
  $('time-label').textContent = srcs;
}

/** Renvoie faux si l'heure n'a pas changé (borne du curseur atteinte). */
function setOffset(offsetH: number): boolean {
  offsetH = Math.min(Number(timeRange.max), Math.max(Number(timeRange.min), offsetH));
  const t = hourNow() + offsetH * 3600_000;
  if (live === (offsetH === 0) && (live || t === fixedTime)) return false;
  live = offsetH === 0;
  fixedTime = t;
  renderLayers();
  return true;
}
timeRange.addEventListener('input', () => setOffset(Number(timeRange.value)));
// Boutons −1 h / +1 h (le curseur seul est difficile à régler au doigt) ; appui maintenu : défilement
for (const [id, step] of [['time-prev', -1], ['time-next', 1]] as const) {
  const btn = $(id);
  let timer = 0;
  const stop = () => { clearTimeout(timer); timer = 0; };
  const tick = (delay: number) => {
    if (!setOffset(Number(timeRange.value) + step)) { stop(); return; } // borne atteinte : plus rien à défiler
    timer = window.setTimeout(() => tick(Math.max(80, delay * 0.8)), delay);
  };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); stop(); tick(400); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOffset(Number(timeRange.value) + step); } });
}
// « Maintenant » : revenir à l'heure courante et recharger une prévision trop ancienne
$('time-now').onclick = () => { live = true; updateLayers(); };

function toggleLayer(key: 'windLayer' | 'currentLayer', layer: string) {
  settings = { ...settings, [key]: !settings[key] };
  saveSettings(settings);
  // Indépendant du style de carte (qui peut ne pas être chargé, ex. hors-ligne sans carte)
  if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', settings[key] ? 'visible' : 'none');
  updateLayers();
}
$('wind-btn').onclick = () => toggleLayer('windLayer', 'wind');
$('current-btn').onclick = () => toggleLayer('currentLayer', 'current');
map.on('moveend', renderLayers);
// Chaque minute en mode « maintenant » (le courant évolue vite) ; toutes les 10 min, rafraîchir la prévision
setInterval(() => { if (live && (settings.windLayer || settings.currentLayer)) renderLayers(); }, 60_000);
setInterval(() => { if (settings.windLayer || settings.currentLayer) updateLayers(); }, 600_000);

async function loadChart() {
  remote = await remoteManifest();
  try {
    current = await openChart(remote);
  } catch (err) {
    current = null;
    toast(`Lecture de la carte impossible : ${(err as Error).message}`, 8000);
  }
  // Libérer l'ancienne carte (ex. passage en ligne → hors-ligne, ou carte supprimée)
  for (const k of [...protocol.tiles.keys()]) if (k !== current?.pm.source.getKey()) protocol.tiles.delete(k);
  if (!current) {
    sourceUrl = styledSource = '';
    map.setStyle({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#cfd3d6' } }] });
    updateEditionUi();
    $('edition').textContent = 'carte indisponible hors connexion : téléchargez-la une fois en ligne';
    $('edition').hidden = false; // seul cas où le bouton ⓘ affiche un texte
    toast('Pas de carte : connectez-vous pour la télécharger.');
    return;
  }
  protocol.add(current.pm);
  sourceUrl = `pmtiles://${current.pm.source.getKey()}`;
  // Pas de défilement loin au-delà des données (le fond gris n'apprend rien) : emprise + ~10 km
  const [w, s, e, n] = current.manifest.bounds;
  map.setMaxBounds([[w - 0.15, s - 0.1], [e + 0.15, n + 0.1]]);
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
  $('edition').hidden = true;
  $('about-edition').textContent = formatEdition(m);
  $('offline-badge').hidden = !current?.offline;
  $('chart-btn').classList.toggle('ok', !!current?.offline);
}

// ---------- identification au tap ----------
const QUERY_LAYERS = ['buoys', 'beacons', 'lights', 'topmar', 'dangers', 'notmrk', 'harbour', 'bridge-line', 'bridge-fill',
  'cblohd', 'clearance', 'ofsplf', 'areas', 'tsezne', 'soundg', 'soundg-drying', 'covr', 'depare', 'unsare'];

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
let wakeLock: WakeLockSentinel | null = null;

const boat = new Boat(onFix, (msg) => {
  toast(msg);
  if (!boat.active) { following = false; zoomOnFirstFix = false; keepAwake(!!recording); } // permission refusée : GPS arrêté
  setLocateUi();
});
let zoomOnFirstFix = false;
const DEFAULT_FIX_ZOOM = 14;

let coarseWarned = false;
let coarseCount = 0;

function onFix(f: Fix) {
  // Précision kilométrique répétée : position « approximative » accordée par le système (Android 12+)
  coarseCount = f.acc > 500 ? coarseCount + 1 : 0;
  if (coarseCount >= 3 && !coarseWarned) {
    coarseWarned = true;
    toast(`Position approximative (±${Math.round(f.acc)} m) : le téléphone ne donne pas la position exacte à ce navigateur. Android : Paramètres → Applications → ${browserName()} → Autorisations → Position → « Utiliser la position exacte ».`, 15000);
  }
  renderBoat(f);
  if (zoomOnFirstFix) {
    // Première position : centrer et zoomer au niveau par défaut (balisage, sondes, alarme active)
    zoomOnFirstFix = false;
    map.jumpTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), DEFAULT_FIX_ZOOM) });
  }
  if (!following) renderPanel(); // en suivi, moveend s'en charge
  $('instruments').hidden = false;
  $('sog').textContent = f.sog.toFixed(1);
  $('cog').textContent = f.cog == null ? '–' : String(Math.round(f.cog)).padStart(3, '0');
  $('pos').textContent = `${formatLatLon(f.lat, f.lon)} ±${Math.round(f.acc)} m${f.acc > 500 ? ' · position approximative !' : f.acc > 30 ? ' · GPS imprécis' : ''}`;
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
const ALARM_MAX_ACC_M = 50;  // au-delà, la position ne permet pas de juger des hauts-fonds
const ALARM_MIN_ZOOM = 12;   // en dessous, géométries trop simplifiées et dangers absents des tuiles

/** Danger isolé : sonde ≤ contour de sécurité, ou sans sonde mais découvrant / émergé. Même règle que `dangerous` dans style.ts. */
function isDangerous(p: Props, safety: number): boolean {
  if (p.VALSOU != null) return Number(p.VALSOU) <= safety;
  return ['1', '2', '4', '5'].includes(String(p.WATLEV ?? ''));
}

function setAlarmStatus(text: string, suspended: boolean) {
  const el = $('alarm-status');
  el.textContent = text;
  el.classList.toggle('suspended', suspended);
}

/**
 * Alarme si la position, ou le vecteur d'anticipation, entre dans une zone moins profonde que le
 * contour de sécurité, sur la terre / une zone non hydrographiée, ou près d'un danger isolé.
 * Quand le contrôle est impossible (position imprécise, zoom trop faible, hors écran), l'état est
 * affiché comme suspendu et une alarme en cours n'est pas effacée.
 */
function checkShallows(f: Fix) {
  if (!boat.active || !map.getLayer('depare')) return; // GPS arrêté entre-temps
  if (!map.isStyleLoaded()) { map.once('idle', () => checkShallows(boat.last ?? f)); return; }
  if (f.acc > ALARM_MAX_ACC_M) {
    $('depth').textContent = '?';
    $('instruments').classList.remove('shallow');
    setAlarmStatus(`Alarme suspendue : position imprécise (±${Math.round(f.acc)} m)`, true);
    return;
  }
  if (map.getZoom() < ALARM_MIN_ZOOM) {
    setAlarmStatus(`Alarme suspendue : zoomer davantage (niveau ${ALARM_MIN_ZOOM} minimum)`, true);
    return;
  }
  const safety = safetyDepth(settings);
  const pts = [{ lat: f.lat, lon: f.lon }];
  if (f.cog != null && f.sog > 0.4 && settings.lookAheadMin > 0) {
    const dist = (f.sog * 1852 * settings.lookAheadMin) / 60;
    for (let i = 1; i <= 6; i++) pts.push(destination(f, f.cog, (dist * i) / 6));
  }
  const canvas = map.getCanvas();
  let hereMin: number | null = null;
  let hereMax: number | null = null;
  let offscreen = 0;
  let alarm: { level: number; msg: string } | null = null;
  const raise = (level: number, msg: string) => { if (!alarm || level > alarm.level) alarm = { level, msg }; };
  const ahead = `droit devant (< ${settings.lookAheadMin} min)`;
  pts.forEach((p, i) => {
    const px = map.project([p.lon, p.lat]);
    if (px.x < 0 || px.y < 0 || px.x > canvas.clientWidth || px.y > canvas.clientHeight) { offscreen++; return; }
    const areas = map.queryRenderedFeatures(px, { layers: ['depare'] });
    const d1 = areas.map((a) => Number(a.properties.DRVAL1)).filter((v) => !Number.isNaN(v));
    if (i === 0 && d1.length) {
      hereMin = Math.min(...d1);
      const d2 = areas.map((a) => Number(a.properties.DRVAL2)).filter((v) => !Number.isNaN(v));
      hereMax = d2.length ? Math.max(...d2) : null;
    }
    if (d1.length && Math.min(...d1) < safety) {
      raise(i === 0 ? 3 : 1, i === 0 ? `Haut-fond sous le bateau (${depthText(Math.min(...d1))})` : `Haut-fond ${ahead} (${depthText(Math.min(...d1))})`);
    } else if (!d1.length) {
      // Pas de zone de profondeur : terre, digue ou zone non hydrographiée
      const other = map.queryRenderedFeatures(px, { layers: ['lndare', 'unsare'].filter((l) => map.getLayer(l)) });
      const land = other.some((o) => o.properties.objl === 'LNDARE');
      // Bassin portuaire de la couche indicative : de l'eau, mais sans aucune sonde
      const what = land ? 'Terre' : other.some((o) => o.properties.src === 'ns') ? 'Bassin sans sondes' : 'Zone non hydrographiée';
      if (i > 0 && other.length) raise(1, `${what} ${ahead}`);
      else if (i === 0 && !land && other.length) raise(2, `${what} sous le bateau : profondeur inconnue`);
    }
    const near = map.queryRenderedFeatures([[px.x - 10, px.y - 10], [px.x + 10, px.y + 10]], { layers: ['alarm-dangers'] });
    const hit = near.find((n) => isDangerous(n.properties as Props, safety));
    if (hit) {
      const v = hit.properties.VALSOU;
      raise(2, `Danger isolé ${i === 0 ? 'à proximité' : ahead}${v != null ? ` (${depthText(Number(v))})` : ''}`);
    }
  });
  $('depth').textContent = hereMin == null ? '–'
    : hereMax != null && hereMax <= 0 ? 'estran'
    : hereMax != null ? `${fmt(Math.max(0, hereMin))}–${fmt(hereMax)}` : fmt(hereMin);
  $('instruments').classList.toggle('shallow', hereMin != null && hereMin < safety);
  if (offscreen === pts.length) { setAlarmStatus('Alarme suspendue : bateau hors de l’écran', true); return; }
  setAlarmStatus(offscreen ? 'Alarme partielle : vecteur d’anticipation hors de l’écran' : `Alarme active (sécurité ${fmt(safety)} m)`, offscreen > 0);
  setAlarm(alarm);
}

const fmt = (v: number) => v.toLocaleString('fr-BE');
// Profondeur négative = hauteur découvrante (au-dessus du zéro des cartes)
const depthText = (v: number) => (v < 0 ? `découvre jusqu’à ${fmt(-v)} m` : `${fmt(v)} m`);

// Son de l'alarme : le contexte audio doit être créé/débloqué lors d'un geste (iOS, Safari)
let audio: AudioContext | null = null;
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* audio indisponible */ }
}

// Niveau acquitté : une alarme plus grave (1 droit devant < 2 danger < 3 sous le bateau) sonne à nouveau
let ackedLevel = 0;
let shownLevel = 0;
function setAlarm(a: { level: number; msg: string } | null) {
  const el = $('alarm');
  if (!a) {
    el.hidden = true;
    ackedLevel = shownLevel = 0;
    return;
  }
  $('alarm-text').textContent = a.msg;
  if (a.level <= ackedLevel) return;
  el.hidden = false;
  if (a.level > shownLevel) {
    shownLevel = a.level;
    navigator.vibrate?.([300, 120, 300]);
    try {
      if (audio) {
        if (audio.state === 'suspended') audio.resume();
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.frequency.value = 880;
        g.gain.value = 0.2;
        o.connect(g).connect(audio.destination);
        o.start();
        o.stop(audio.currentTime + 0.5);
      }
    } catch { /* audio indisponible */ }
  }
}
$('alarm-ack').onclick = () => { ackedLevel = shownLevel; $('alarm').hidden = true; };

// Bouton position : 1er appui = GPS + suivi ; appui suivant = suivi on/off ; appui long = arrêt du GPS
const locateBtn = $('locate-btn');
function setLocateUi() {
  locateBtn.classList.toggle('on', boat.active && !following);
  locateBtn.classList.toggle('following', boat.active && following);
}
let suppressClick = false;
locateBtn.onclick = async () => {
  if (suppressClick) { suppressClick = false; return; } // fin d'un appui long
  unlockAudio(); // geste utilisateur : permet le son de l'alarme sur iOS
  if (!boat.active) {
    following = true;
    zoomOnFirstFix = true;
    boat.start();
    await keepAwake(true);
    if (boat.active) toast('GPS activé. Appui long pour l’arrêter.');
  } else {
    following = !following;
    if (following && boat.last) map.easeTo({ center: [boat.last.lon, boat.last.lat] });
  }
  setLocateUi();
};
let pressTimer = 0;
locateBtn.addEventListener('pointerdown', () => {
  suppressClick = false; // un appui long sans « click » ne doit pas avaler le tap suivant
  pressTimer = window.setTimeout(() => {
    boat.stop();
    following = false;
    zoomOnFirstFix = false;
    keepAwake(!!recording);
    $('instruments').hidden = true;
    setAlarm(null);
    setAlarmStatus('', false);
    (map.getSource('boat') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
    renderPanel();
    setLocateUi();
    toast('GPS arrêté');
    suppressClick = true;
  }, 800);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) locateBtn.addEventListener(ev, () => clearTimeout(pressTimer));
map.on('dragstart', () => {
  zoomOnFirstFix = false; // l'utilisateur regarde ailleurs : ne pas le déplacer au premier fix
  if (following) { following = false; setLocateUi(); }
});

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
    unlockAudio();
    if (!boat.active) { boat.start(); setLocateUi(); }
    keepAwake(true);
  }
  $('track-btn').classList.toggle('on', !!recording);
  renderTrack();
  refreshTracks();
}

let tracksGen = 0;
async function refreshTracks() {
  $('track-toggle').textContent = recording ? 'Arrêter l’enregistrement' : 'Démarrer l’enregistrement';
  const gen = ++tracksGen;
  const tracks = (await listTracks()).sort((a, b) => b.id - a.id);
  if (gen !== tracksGen) return; // un appel plus récent remplit la liste
  const list = $('track-list');
  list.innerHTML = '';
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
  if (boat.active && boat.last) map.once('idle', () => checkShallows(boat.last!));
});
$('settings-btn').onclick = () => { fillSettings(); $<HTMLDialogElement>('settings-dlg').showModal(); };
fillSettings();

// ---------- carte hors-ligne ----------
const mb = (b: number) => `${(b / 1e6).toFixed(0)} Mo`;
async function refreshChartDialog() {
  const local = await offlineManifest();
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
  await refreshChartDialog();
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
$('update-btn').onclick = async () => {
  if (recording) await saveTrack(recording);
  if (boat.active && !confirm('Mettre à jour maintenant ? Le GPS et l’alarme seront relancés à la main.')) return;
  updateSW(true);
};
$('about-btn').onclick = () => { renderGpsDiag(); $<HTMLDialogElement>('about-dlg').showModal(); };

function renderGpsDiag() {
  const h = boat.history;
  const list = $('gps-diag-list');
  list.innerHTML = '';
  if (!h.length) return;
  const sat = h.filter((f) => f.alt).length;
  $('gps-diag-text').textContent = `${browserName()} · ${h.length} dernières positions, dont ${sat} avec altitude (fix satellite). `
    + (sat === 0 ? 'Aucune ne vient des satellites : sortir à ciel ouvert et attendre 1 min ; si rien ne change, le navigateur ne reçoit pas le GPS du téléphone (essayer Chrome pour comparer).' : 'Le GPS satellite est bien reçu.');
  for (const f of h) {
    const li = document.createElement('li');
    li.textContent = `${new Date(f.t).toLocaleTimeString('fr-BE')} · ±${Math.round(f.acc)} m · ${f.alt ? 'satellite' : 'réseau/approx.'}${f.speed ? ' · vitesse fournie' : ''}`;
    list.append(li);
  }
}
$('app-version').textContent = `Version ${__APP_VERSION__}`;

function browserName() {
  const ua = navigator.userAgent;
  return /Firefox/.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome/.test(ua) ? 'Chrome' : 'le navigateur';
}

let toastTimer = 0;
function toast(msg: string, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, ms);
}

// Sur mobile, l'onglet peut être tué sans « beforeunload » : sauvegarder dès qu'il passe en arrière-plan
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && recording) saveTrack(recording); });
window.addEventListener('pagehide', () => { if (recording) saveTrack(recording); });

loadChart();
updateLayers();

// Accès console pour le débogage
Object.assign(window, { map });
