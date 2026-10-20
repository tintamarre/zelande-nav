// Style MapLibre inspiré de S-52 (simplifié), entièrement généré : les couleurs de profondeur
// et l'accentuation des sondes dépendent du contour de sécurité choisi dans les réglages.
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { type Settings, safetyContour, safetyDepth } from './settings';

const PALETTES = {
  day: {
    nodata: '#cfd3d6', land: '#efe2b0', built: '#dccb8f', coast: '#1a1a1a', contour: '#7b8a9a',
    drying: '#9cc79a', vshallow: '#61b7ff', shallow: '#97cdf9', medium: '#c8e6fb', deep: '#ffffff',
    unsurveyed: '#bfbfbf', text: '#1a1a1a', soundDeep: '#6b7c8c', soundShallow: '#000000',
    magenta: '#c800c8', halo: 'rgba(255,255,255,0.85)', danger: '#e32020', track: '#ff3b30',
  },
  night: {
    nodata: '#0d0f10', land: '#2a2614', built: '#332e18', coast: '#6e6e5a', contour: '#3a4a5a',
    drying: '#1f3320', vshallow: '#0f2e52', shallow: '#0b2340', medium: '#081a30', deep: '#050c18',
    unsurveyed: '#202020', text: '#b8a878', soundDeep: '#5a6470', soundShallow: '#c8b880',
    magenta: '#a000a0', halo: 'rgba(0,0,0,0.7)', danger: '#c03030', track: '#c03030',
  },
};

const objl = (...classes: string[]): ExpressionSpecification =>
  classes.length === 1 ? ['==', ['get', 'objl'], classes[0]] : ['match', ['get', 'objl'], classes, true, false];

const minzoomOk: ExpressionSpecification = ['>=', ['zoom'], ['coalesce', ['get', 'minz'], 0]];

export function buildStyle(s: Settings, sourceUrl: string, glyphsBase: string): StyleSpecification {
  const P = s.night ? PALETTES.night : PALETTES.day;
  // Seuils strictement croissants (exigé par l'expression « step »), même avec des réglages extrêmes
  const shallow = Math.max(0.1, Math.min(s.draft, safetyDepth(s)));
  const safety = Math.max(shallow + 0.1, safetyDepth(s));
  const deep = Math.max(s.deepContour, safety + 0.5);
  const sc = safetyContour(s);
  const air = s.airDraft;

  const depthColour = (attr = 'DRVAL1'): ExpressionSpecification => [
    'step', ['coalesce', ['get', attr], 0],
    P.drying, 0, P.vshallow, shallow, P.shallow, safety, P.medium, deep, P.deep,
  ];

  // Taille du texte des sondes : chiffres entiers + décimale plus petite (convention des cartes)
  const d: ExpressionSpecification = ['abs', ['get', 'depth']];
  const whole: ExpressionSpecification = ['floor', d];
  const dec: ExpressionSpecification = ['round', ['*', ['-', d, whole], 10]];
  const soundingText: ExpressionSpecification = [
    'case',
    ['>=', d, 10], ['format', ['to-string', ['round', d]], {}],
    ['==', dec, 0], ['format', ['to-string', whole], {}],
    ['format', ['to-string', whole], {}, ['to-string', dec], { 'font-scale': 0.72 }],
  ];

  const lightText: ExpressionSpecification = [
    'concat',
    ['match', ['to-string', ['get', 'LITCHR']],
      '1', 'F', '2', 'Fl', '3', 'LFl', '4', 'Q', '5', 'VQ', '6', 'UQ', '7', 'Iso', '8', 'Oc', '9', 'IQ',
      '12', 'Mo', '19', 'Al.Fl', '28', 'Al', ''],
    ['match', ['coalesce', ['get', 'SIGGRP'], ''], ['()', '(1)', ''], '', ['get', 'SIGGRP']],
    ['match', ['coalesce', ['get', 'COLOUR'], ''], '1', 'W', '3', 'R', '4', 'G', '6', 'Y',
      '1,3', 'WR', '3,1', 'WR', '1,4', 'WG', '4,1', 'WG', '1,3,4', 'WRG', '3,4', 'RG', ''],
    ['case', ['has', 'SIGPER'], ['concat', ' ', ['to-string', ['get', 'SIGPER']], 's'], ''],
  ];

  // Échelle de couleur du vent (nœuds) : calme, maniable, frais, fort, coup de vent
  const windColour: ExpressionSpecification = ['step', ['get', 'speed'],
    '#2f7fd8', 11, '#1f9e3a', 17, '#e0a000', 22, '#e05a00', 28, '#d11a1a', 34, '#9b00b0'];

  const clearance: ExpressionSpecification = ['coalesce', ['get', 'VERCLR'], ['get', 'VERCCL'], 999];

  const layers: LayerSpecification[] = [
    { id: 'bg', type: 'background', paint: { 'background-color': P.nodata } },
    // --- surfaces ---
    { id: 'depare', type: 'fill', source: 'enc', 'source-layer': 'enc', filter: objl('DEPARE', 'DRGARE'),
      paint: { 'fill-color': depthColour(), 'fill-antialias': false } },
    { id: 'unsare', type: 'fill', source: 'enc', 'source-layer': 'enc', filter: objl('UNSARE'),
      paint: { 'fill-color': P.unsurveyed } },
    { id: 'lndare', type: 'fill', source: 'enc', 'source-layer': 'enc', filter: objl('LNDARE'),
      paint: { 'fill-color': P.land } },
    { id: 'buaare', type: 'fill', source: 'enc', 'source-layer': 'enc', filter: objl('BUAARE'),
      paint: { 'fill-color': P.built } },
    { id: 'bridge-fill', type: 'fill', source: 'enc', 'source-layer': 'enc',
      filter: ['all', objl('BRIDGE', 'bridge'), ['==', ['geometry-type'], 'Polygon']],
      paint: { 'fill-color': ['case', ['<', clearance, air], P.danger, '#8c8c8c'], 'fill-opacity': 0.75 } },
    { id: 'ponton', type: 'fill', source: 'enc', 'source-layer': 'enc', filter: objl('PONTON', 'FLODOC', 'DRYDOC'),
      paint: { 'fill-color': '#a8a8a8', 'fill-outline-color': P.coast } },
    // --- zones réglementées (contours tiretés magenta) ---
    { id: 'areas', type: 'line', source: 'enc', 'source-layer': 'enc',
      filter: objl('RESARE', 'resare', 'ACHARE', 'achare', 'CTNARE', 'PRCARE', 'MARCUL', 'CBLARE', 'PIPARE', 'DMPGRD', 'MIPARE'),
      minzoom: 11,
      paint: { 'line-color': P.magenta, 'line-width': 1, 'line-dasharray': [4, 3], 'line-opacity': 0.7 } },
    { id: 'fairwy', type: 'line', source: 'enc', 'source-layer': 'enc', filter: objl('FAIRWY'), minzoom: 10,
      paint: { 'line-color': '#7a5fa8', 'line-width': 0.8, 'line-dasharray': [6, 4], 'line-opacity': 0.6 } },
    // --- isobathes ---
    { id: 'depcnt', type: 'line', source: 'enc', 'source-layer': 'enc', filter: ['all', objl('DEPCNT'), minzoomOk],
      paint: { 'line-color': P.contour, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 15, 0.8] } },
    { id: 'safety-contour', type: 'line', source: 'enc', 'source-layer': 'enc',
      filter: ['all', objl('DEPCNT'), ['==', ['get', 'VALDCO'], sc]],
      paint: { 'line-color': s.night ? '#9a8a5a' : '#000000', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 15, 2.2] } },
    // --- côte, ouvrages, lignes ---
    { id: 'coalne', type: 'line', source: 'enc', 'source-layer': 'enc', filter: objl('COALNE'),
      paint: { 'line-color': P.coast, 'line-width': 1 } },
    { id: 'slcons', type: 'line', source: 'enc', 'source-layer': 'enc', filter: objl('SLCONS', 'DYKCON', 'DAMCON', 'GATCON', 'CAUSWY'),
      paint: { 'line-color': P.coast, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 15, 2.5] } },
    { id: 'bridge-line', type: 'line', source: 'enc', 'source-layer': 'enc', filter: objl('BRIDGE', 'bridge'),
      paint: { 'line-color': ['case', ['<', clearance, air], P.danger, '#4a4a4a'], 'line-width': 2.5 } },
    { id: 'cblohd', type: 'line', source: 'enc', 'source-layer': 'enc', filter: objl('CBLOHD', 'cblohd'),
      paint: { 'line-color': ['case', ['<', clearance, air], P.danger, P.magenta], 'line-width': 1.5, 'line-dasharray': [3, 2] } },
    { id: 'navlne', type: 'line', source: 'enc', 'source-layer': 'enc', filter: objl('NAVLNE', 'RECTRC', 'FERYRT'), minzoom: 11,
      paint: { 'line-color': P.coast, 'line-width': 1, 'line-dasharray': [6, 3] } },
    { id: 'cblsub', type: 'line', source: 'enc', 'source-layer': 'enc', filter: ['all', objl('CBLSUB', 'PIPSOL'), minzoomOk],
      paint: { 'line-color': P.magenta, 'line-width': 0.8, 'line-dasharray': [1, 2], 'line-opacity': 0.6 } },
    { id: 'pylons', type: 'circle', source: 'enc', 'source-layer': 'enc', filter: objl('PYLONS', 'PILPNT'), minzoom: 13,
      paint: { 'circle-radius': 1.8, 'circle-color': P.coast } },
    // --- sondes ---
    ...(s.soundings ? soundingLayers(soundingText, safety, P) : []),
    // --- noms ---
    { id: 'names', type: 'symbol', source: 'enc', 'source-layer': 'enc', filter: ['all', objl('SEAARE', 'LNDRGN', 'hrbare'), ['has', 'OBJNAM']],
      minzoom: 10,
      layout: { 'text-field': ['get', 'OBJNAM'], 'text-font': ['Noto Sans Italic'], 'text-size': 13,
        'symbol-placement': 'point', 'text-max-width': 8 },
      paint: { 'text-color': s.night ? P.text : '#2b5f8a', 'text-halo-color': P.halo, 'text-halo-width': 1.2 } },
    // --- dangers ---
    { id: 'dangers', type: 'symbol', source: 'enc', 'source-layer': 'enc', filter: ['all', objl('WRECKS', 'OBSTRN', 'UWTROC'), minzoomOk],
      layout: {
        'icon-image': ['case',
          ['all', ['has', 'VALSOU'], ['<=', ['get', 'VALSOU'], safety]], 'isodgr',
          ['==', ['get', 'objl'], 'WRECKS'], 'wreck',
          ['==', ['get', 'objl'], 'UWTROC'], 'rock', 'obstn'],
        'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 15, 1],
        'text-field': ['case', ['has', 'VALSOU'], ['to-string', ['get', 'VALSOU']], ''],
        'text-font': ['Noto Sans Italic'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-optional': true,
      },
      paint: { 'text-color': P.text, 'text-halo-color': P.halo, 'text-halo-width': 1 } },
    // --- balisage ---
    { id: 'beacons', type: 'symbol', source: 'enc', 'source-layer': 'enc',
      filter: ['all', objl('BCNLAT', 'BCNCAR', 'BCNISD', 'BCNSAW', 'BCNSPP'), minzoomOk],
      layout: {
        'icon-image': ['concat', 'bcn|', ['to-string', ['coalesce', ['get', 'BCNSHP'], '1']], '|',
          ['coalesce', ['get', 'COLOUR'], ''], '|', ['to-string', ['coalesce', ['get', 'COLPAT'], '']]],
        'icon-anchor': 'bottom', 'icon-allow-overlap': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 1],
      } },
    { id: 'buoys', type: 'symbol', source: 'enc', 'source-layer': 'enc',
      filter: ['all', objl('BOYLAT', 'BOYCAR', 'BOYISD', 'BOYSAW', 'BOYSPP'), minzoomOk],
      layout: {
        'icon-image': ['concat', 'boy|', ['to-string', ['coalesce', ['get', 'BOYSHP'], '4']], '|',
          ['coalesce', ['get', 'COLOUR'], ''], '|', ['to-string', ['coalesce', ['get', 'COLPAT'], '']]],
        'icon-anchor': 'bottom', 'icon-allow-overlap': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 1],
        'text-field': ['coalesce', ['get', 'OBJNAM'], ''], 'text-font': ['Noto Sans Medium'], 'text-size': 11,
        'text-anchor': 'left', 'text-offset': [0.9, -0.6], 'text-optional': true,
      },
      paint: { 'text-color': P.text, 'text-halo-color': P.halo, 'text-halo-width': 1.2,
        'text-opacity': ['step', ['zoom'], 0, 13, 1] } },
    { id: 'topmar', type: 'symbol', source: 'enc', 'source-layer': 'enc', filter: ['all', objl('TOPMAR', 'DAYMAR'), minzoomOk],
      layout: {
        'icon-image': ['concat', 'top|', ['to-string', ['coalesce', ['get', 'TOPSHP'], '33']], '|', ['coalesce', ['get', 'COLOUR'], '2']],
        'icon-anchor': 'bottom', 'icon-offset': [0, -19], 'icon-allow-overlap': true,
      } },
    { id: 'lights', type: 'symbol', source: 'enc', 'source-layer': 'enc', filter: ['all', objl('LIGHTS'), minzoomOk],
      layout: {
        'icon-image': ['concat', 'light|', ['coalesce', ['get', 'COLOUR'], '']],
        'icon-allow-overlap': true, 'icon-offset': [0, -6],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 1],
        'text-field': lightText, 'text-font': ['Noto Sans Regular'], 'text-size': 10.5,
        'text-anchor': 'left', 'text-offset': [1.4, 0.4], 'text-optional': true,
      },
      paint: { 'text-color': P.magenta, 'text-halo-color': P.halo, 'text-halo-width': 1.2,
        'text-opacity': ['step', ['zoom'], 0, 13, 1] } },
    { id: 'notmrk', type: 'symbol', source: 'enc', 'source-layer': 'enc', filter: ['all', objl('notmrk'), minzoomOk],
      layout: { 'icon-image': 'notice', 'icon-allow-overlap': false } },
    { id: 'harbour', type: 'symbol', source: 'enc', 'source-layer': 'enc', filter: objl('HRBFAC', 'hrbfac', 'SMCFAC'), minzoom: 11,
      layout: { 'icon-image': 'harbour', 'text-field': ['coalesce', ['get', 'OBJNAM'], ''], 'text-font': ['Noto Sans Medium'],
        'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-optional': true },
      paint: { 'text-color': P.magenta, 'text-halo-color': P.halo, 'text-halo-width': 1.2 } },
    // --- tirant d'air des ponts et câbles ---
    { id: 'clearance', type: 'symbol', source: 'enc', 'source-layer': 'enc',
      filter: ['all', objl('BRIDGE', 'bridge', 'CBLOHD', 'cblohd'), ['any', ['has', 'VERCLR'], ['has', 'VERCCL']]],
      minzoom: 12,
      layout: { 'text-field': ['concat', 'H ', ['to-string', clearance], ' m'], 'text-font': ['Noto Sans Medium'],
        'text-size': 11, 'symbol-placement': 'point' },
      paint: { 'text-color': ['case', ['<', clearance, air], P.danger, P.text], 'text-halo-color': P.halo, 'text-halo-width': 1.5 } },
    // --- couche optionnelle : vent (flèches dans le sens du vent, couleur et taille selon la force) ---
    { id: 'wind', type: 'symbol', source: 'wind',
      layout: {
        visibility: s.windLayer ? 'visible' : 'none',
        'icon-image': ['concat', 'warrow|', windColour],
        'icon-rotate': ['get', 'to'], 'icon-rotation-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['get', 'speed'], 0, 0.55, 10, 0.8, 25, 1.15],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'text-field': ['to-string', ['get', 'speed']], 'text-font': ['Noto Sans Medium'], 'text-size': 12,
        'text-offset': [0, 1.7], 'text-allow-overlap': true, 'text-ignore-placement': true,
      },
      paint: { 'text-color': windColour, 'text-halo-color': P.halo, 'text-halo-width': 2, 'icon-opacity': 0.8 } },
    // --- bateau ---
    { id: 'track', type: 'line', source: 'track', paint: { 'line-color': P.track, 'line-width': 2, 'line-opacity': 0.8 } },
    { id: 'vector', type: 'line', source: 'boat', filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': P.track, 'line-width': 2, 'line-dasharray': [2, 1.5] } },
    { id: 'accuracy', type: 'circle', source: 'boat', filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-color': '#1f8fff', 'circle-opacity': 0.12, 'circle-stroke-color': '#1f8fff', 'circle-stroke-width': 1,
        // mètres → pixels à 51,5° N (tuiles 512 px : 48 725 m/px au zoom 0)
        'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, ['/', ['get', 'acc'], 47.6], 20, ['/', ['get', 'acc'], 0.0465]],
      } },
    { id: 'boat', type: 'symbol', source: 'boat', filter: ['==', ['geometry-type'], 'Point'],
      layout: { 'icon-image': 'boat', 'icon-rotate': ['coalesce', ['get', 'cog'], 0], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': 0.8 } },
  ];

  return {
    version: 8,
    glyphs: `${glyphsBase}{fontstack}/{range}.pbf`,
    sources: {
      enc: { type: 'vector', url: sourceUrl, attribution: 'Rijkswaterstaat (CC-0)' },
      boat: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      track: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      wind: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: 'Vent : KNMI via Open-Meteo (CC-BY 4.0)' },
    },
    layers,
  };
}

function soundingLayers(text: ExpressionSpecification, safety: number, P: typeof PALETTES.day): LayerSpecification[] {
  const base = {
    type: 'symbol' as const, source: 'enc', 'source-layer': 'soundg',
    layout: {
      'text-field': text, 'text-font': ['Noto Sans Italic'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 12.5] as ExpressionSpecification,
      'text-padding': 1, 'text-allow-overlap': false,
      'symbol-sort-key': ['get', 'depth'] as ExpressionSpecification, // les moins profondes d'abord
    },
    paint: {
      'text-color': ['case', ['<=', ['get', 'depth'], safety], P.soundShallow, P.soundDeep] as ExpressionSpecification,
      'text-halo-color': P.halo, 'text-halo-width': 0.6,
    },
  };
  return [
    { ...base, id: 'soundg', filter: ['all', ['>=', ['get', 'depth'], 0], minzoomOk] },
    // Hauteurs découvrantes : sans signe moins, soulignées (convention des cartes marines)
    { ...base, id: 'soundg-drying', filter: ['all', ['<', ['get', 'depth'], 0], minzoomOk],
      layout: { ...base.layout, 'icon-image': 'underline', 'icon-text-fit': 'both', 'icon-text-fit-padding': [0, 1, 1, 1] } },
  ];
}
