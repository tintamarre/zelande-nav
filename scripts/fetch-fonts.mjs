// Télécharge les glyphs PBF (Noto Sans, licence OFL) utilisés par la carte, pour un usage
// 100 % hors-ligne. À relancer seulement pour ajouter une police ou une plage Unicode.
// Source : https://github.com/protomaps/basemaps-assets (fonts/)
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = 'https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts';
const FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
// Latin de base + Latin étendu (ë, ĳ…) + ponctuation générale (–, ’, …)
const RANGES = ['0-255', '256-511', '8192-8447'];

for (const font of FONTS) {
  await mkdir(`public/fonts/${font}`, { recursive: true });
  for (const range of RANGES) {
    const url = `${BASE}/${encodeURIComponent(font)}/${range}.pbf`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    await writeFile(`public/fonts/${font}/${range}.pbf`, Buffer.from(await res.arrayBuffer()));
    console.log(`${font} ${range}`);
  }
}
const ofl = await fetch(`${BASE}/OFL.txt`);
await writeFile('public/fonts/OFL.txt', await ofl.text());
