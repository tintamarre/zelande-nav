// Symboles de carte dessinés à la volée (canvas) : pas de sprite à héberger, pas de symboles
// OpenCPN (GPL). Inspirés de S-52 / INT1, simplifiés. Les identifiants encodent les attributs :
//   boy|<BOYSHP>|<COLOUR>|<COLPAT>   bouées
//   bcn|<BCNSHP>|<COLOUR>|<COLPAT>   balises
//   top|<TOPSHP>|<COLOUR>            voyants
//   light|<COLOUR>                   feux (flamme)
//   barb|<nœuds arrondis à 5>|<couleur>   barbules de vent
//   wreck, rock, obstn, isodgr, notice, harbour, underline, boat
// Ils sont générés sur l'événement « styleimagemissing » de MapLibre.
import type { Map as MlMap } from 'maplibre-gl';
import { COLOUR_HEX } from './s57';

const PR = 2; // densité de pixels des images
const INK = '#1a1a1a';
const MAGENTA = '#c800c8';

type Draw = (c: CanvasRenderingContext2D) => void;

function make(w: number, h: number, draw: Draw) {
  const cv = document.createElement('canvas');
  cv.width = w * PR;
  cv.height = h * PR;
  const c = cv.getContext('2d')!;
  c.scale(PR, PR);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  draw(c);
  return c.getImageData(0, 0, cv.width, cv.height);
}

const colours = (s: string) => (s ? s.split(',').map((k) => COLOUR_HEX[k] ?? '#999') : ['#999']);

/** Remplit le chemin courant avec les couleurs en bandes (horizontales par défaut). */
function fillBands(c: CanvasRenderingContext2D, path: Path2D, cols: string[], pat: string, box: [number, number, number, number]) {
  const [x, y, w, h] = box;
  c.save();
  c.clip(path);
  if (cols.length === 1) {
    c.fillStyle = cols[0];
    c.fillRect(x, y, w, h);
  } else if (pat === '2') {
    const bw = w / cols.length;
    cols.forEach((col, i) => { c.fillStyle = col; c.fillRect(x + i * bw, y, bw + 0.5, h); });
  } else {
    const bh = h / cols.length;
    cols.forEach((col, i) => { c.fillStyle = col; c.fillRect(x, y + i * bh, w, bh + 0.5); });
  }
  c.restore();
  c.lineWidth = 1.2;
  c.strokeStyle = INK;
  c.stroke(path);
}

// Bouées : 20 × 22, ancrage en bas au centre (point de mouillage).
function buoy(shape: string, colour: string, pat: string) {
  return make(20, 22, (c) => {
    const p = new Path2D();
    switch (shape) {
      case '1': p.moveTo(10, 3); p.lineTo(16, 20); p.lineTo(4, 20); p.closePath(); break;           // conique
      case '2': p.rect(5, 6, 10, 14); break;                                                      // cylindrique
      case '3': p.arc(10, 13, 7, 0, Math.PI * 2); break;                                           // sphérique
      case '5': p.rect(8, 2, 4, 18); break;                                                       // espar
      case '6': p.roundRect(3, 11, 14, 9, 4); break;                                               // tonneau
      case '7': p.rect(2, 9, 16, 11); break;                                                      // super-bouée
      default: p.moveTo(8, 2); p.lineTo(12, 2); p.lineTo(16, 20); p.lineTo(4, 20); p.closePath();  // fuseau
    }
    fillBands(c, p, colours(colour), pat, [0, 0, 20, 22]);
    c.beginPath(); c.moveTo(1, 21); c.lineTo(19, 21); c.lineWidth = 1; c.strokeStyle = INK; c.stroke();
  });
}

// Balises : perche ou tourelle, 14 × 24, ancrage en bas.
function beacon(shape: string, colour: string, pat: string) {
  return make(14, 24, (c) => {
    const p = new Path2D();
    if (shape === '1' || shape === '2' || shape === '5') p.rect(5.5, 3, 3, 20);
    else { p.moveTo(5, 3); p.lineTo(9, 3); p.lineTo(12, 22); p.lineTo(2, 22); p.closePath(); }
    fillBands(c, p, colours(colour), pat, [0, 0, 14, 24]);
  });
}

// Voyants : 16 × 16, ancrage en bas (posé sur la bouée via icon-offset).
function topmark(shape: string, colour: string) {
  const col = colours(colour)[0];
  return make(16, 16, (c) => {
    c.fillStyle = col;
    c.strokeStyle = INK;
    c.lineWidth = 1;
    const cone = (x: number, y: number, up: boolean) => {
      c.beginPath();
      if (up) { c.moveTo(x, y - 6); c.lineTo(x + 4, y); c.lineTo(x - 4, y); }
      else { c.moveTo(x - 4, y - 6); c.lineTo(x + 4, y - 6); c.lineTo(x, y); }
      c.closePath(); c.fill(); c.stroke();
    };
    const ball = (x: number, y: number) => { c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.fill(); c.stroke(); };
    switch (shape) {
      case '1': cone(8, 15, true); break;
      case '2': cone(8, 15, false); break;
      case '3': ball(8, 12); break;
      case '4': ball(8, 12); ball(8, 5); break;
      case '5': c.fillRect(5, 8, 6, 7); c.strokeRect(5, 8, 6, 7); break;
      case '7': c.lineWidth = 2.5; c.strokeStyle = col; c.beginPath(); c.moveTo(4, 7); c.lineTo(12, 15); c.moveTo(12, 7); c.lineTo(4, 15); c.stroke(); break;
      case '10': cone(8, 8, false); cone(8, 15, true); break;   // Ouest : pointes l'une vers l'autre
      case '11': cone(8, 8, true); cone(8, 15, false); break;   // Est : bases l'une contre l'autre
      case '13': cone(8, 8, true); cone(8, 15, true); break;    // Nord
      case '14': cone(8, 8, false); cone(8, 15, false); break;  // Sud
      default: c.fillRect(5, 9, 6, 6); c.strokeRect(5, 9, 6, 6);
    }
  });
}

// Feu : flamme S-52 orientée à 135°, pointe au centre de l'image (ancrage center).
function light(colour: string) {
  const first = colour.split(',')[0];
  const fill = first === '3' ? '#e32020' : first === '4' ? '#1f9e3a' : first === '1' || first === '6' ? '#ffd400' : MAGENTA;
  return make(32, 32, (c) => {
    c.translate(16, 16);
    c.rotate((135 * Math.PI) / 180);
    c.beginPath();
    c.moveTo(0, 0);
    c.bezierCurveTo(4, -5, 4, -12, 0, -15);
    c.bezierCurveTo(-4, -12, -4, -5, 0, 0);
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = 0.8;
    c.stroke();
  });
}

const STATIC: Record<string, () => ImageData> = {
  wreck: () => make(20, 14, (c) => {
    c.strokeStyle = INK; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(2, 7); c.lineTo(18, 7); c.moveTo(7, 3); c.lineTo(7, 11); c.moveTo(10, 2); c.lineTo(10, 12); c.moveTo(13, 3); c.lineTo(13, 11); c.stroke();
  }),
  rock: () => make(14, 14, (c) => {
    c.strokeStyle = INK; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(7, 2); c.lineTo(7, 12); c.moveTo(2, 7); c.lineTo(12, 7); c.stroke();
    c.fillStyle = INK; for (const [x, y] of [[3.5, 3.5], [10.5, 3.5], [3.5, 10.5], [10.5, 10.5]]) { c.beginPath(); c.arc(x, y, 1, 0, 7); c.fill(); }
  }),
  obstn: () => make(18, 18, (c) => {
    c.strokeStyle = INK; c.lineWidth = 1.2; c.setLineDash([2, 2]);
    c.beginPath(); c.arc(9, 9, 7, 0, Math.PI * 2); c.stroke();
  }),
  isodgr: () => make(20, 20, (c) => {
    c.strokeStyle = MAGENTA; c.lineWidth = 2; c.fillStyle = 'rgba(200,0,200,0.12)';
    c.beginPath(); c.arc(10, 10, 8, 0, Math.PI * 2); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(6, 6); c.lineTo(14, 14); c.moveTo(14, 6); c.lineTo(6, 14); c.stroke();
  }),
  notice: () => make(12, 12, (c) => {
    c.fillStyle = '#ffffff'; c.strokeStyle = '#1f5fd0'; c.lineWidth = 2;
    c.fillRect(2, 2, 8, 8); c.strokeRect(2, 2, 8, 8);
  }),
  harbour: () => make(18, 18, (c) => {
    c.fillStyle = '#ffffff'; c.strokeStyle = MAGENTA; c.lineWidth = 1.5;
    c.beginPath(); c.arc(9, 9, 7.5, 0, 7); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(9, 4); c.lineTo(9, 14); c.moveTo(6, 6.5); c.lineTo(12, 6.5);
    c.moveTo(4.5, 10); c.quadraticCurveTo(9, 16, 13.5, 10); c.stroke();
  }),
  // Trait sous les hauteurs découvrantes (étiré sur la largeur du texte par icon-text-fit)
  underline: () => make(8, 8, (c) => { c.fillStyle = INK; c.fillRect(0, 6.5, 8, 1.2); }),
  boat: () => make(28, 40, (c) => {
    c.beginPath();
    c.moveTo(14, 2); c.bezierCurveTo(23, 12, 23, 30, 20, 38); c.lineTo(8, 38); c.bezierCurveTo(5, 30, 5, 12, 14, 2); c.closePath();
    c.fillStyle = '#ff3b30'; c.fill(); c.strokeStyle = '#ffffff'; c.lineWidth = 2.5; c.stroke();
    c.fillStyle = '#ffffff'; c.beginPath(); c.arc(14, 22, 3, 0, 7); c.fill();
  }),
};

// Barbule de vent : hampe vers le nord (le vent vient du nord ; rotation = direction d'origine),
// station au centre. Fanion = 50 kn, trait long = 10 kn, trait court = 5 kn (convention OMM).
function barb(knots: number, colour: string) {
  return make(44, 44, (c) => {
    c.strokeStyle = colour;
    c.fillStyle = colour;
    c.lineWidth = 1.8;
    if (knots < 3) {
      c.beginPath(); c.arc(22, 22, 4, 0, Math.PI * 2); c.stroke();
      return;
    }
    const top = 3, step = 4.5;
    c.beginPath(); c.moveTo(22, 22); c.lineTo(22, top); c.stroke();
    c.beginPath(); c.arc(22, 22, 1.8, 0, Math.PI * 2); c.fill();
    let k = Math.round(knots / 5) * 5;
    let y = top;
    while (k >= 50) { c.beginPath(); c.moveTo(22, y); c.lineTo(33, y + 2.5); c.lineTo(22, y + 5); c.closePath(); c.fill(); y += 6.5; k -= 50; }
    while (k >= 10) { c.beginPath(); c.moveTo(22, y); c.lineTo(33, y - 3); c.stroke(); y += step; k -= 10; }
    if (k >= 5) { if (y === top) y += step; c.beginPath(); c.moveTo(22, y); c.lineTo(27.5, y - 1.5); c.stroke(); }
  });
}

export function registerSymbols(map: MlMap) {
  map.on('styleimagemissing', (e: { id: string }) => {
    const id = e.id;
    if (map.hasImage(id)) return;
    const [kind, a = '', b = '', c = ''] = id.split('|');
    let img: ImageData | undefined;
    if (kind === 'boy') img = buoy(a, b, c);
    else if (kind === 'bcn') img = beacon(a, b, c);
    else if (kind === 'top') img = topmark(a, b);
    else if (kind === 'light') img = light(a);
    else if (kind === 'barb') img = barb(Number(a), b || INK);
    else if (STATIC[kind]) img = STATIC[kind]();
    if (!img) return;
    map.addImage(id, img, {
      pixelRatio: PR,
      // trait en bas : seule la partie au-dessus s'étire en hauteur, le trait reste fin
      ...(kind === 'underline' ? { stretchX: [[0, 8 * PR]], stretchY: [[0, 6 * PR]], content: [0, 0, 8 * PR, 6 * PR] } : {}),
    });
  });
}
