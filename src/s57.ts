// Décodage des attributs S-57 / Inland ENC pour l'affichage (popups, libellés).
// Référence : IHO S-57 Ed. 3.1, Appendix A (catalogue des objets) et IENC Feature Catalogue.

export type Props = Record<string, string | number | boolean | undefined>;

export const CLASS_NAMES: Record<string, string> = {
  DEPARE: 'Zone de profondeur', DEPCNT: 'Isobathe', DRGARE: 'Zone draguée', UNSARE: 'Zone non hydrographiée',
  LNDARE: 'Terre', COALNE: 'Trait de côte', SLCONS: 'Ouvrage côtier', BUAARE: 'Zone bâtie',
  LAKARE: 'Lac', CANALS: 'Canal', RIVERS: 'Rivière', SEAARE: 'Étendue d’eau', LNDRGN: 'Lieu-dit',
  DYKCON: 'Digue', LNDMRK: 'Amer', BRIDGE: 'Pont', bridge: 'Pont', PONTON: 'Ponton', CAUSWY: 'Chaussée',
  DAMCON: 'Barrage', GATCON: 'Porte / écluse', DRYDOC: 'Cale sèche', FLODOC: 'Dock flottant',
  lokbsn: 'Sas d’écluse', TUNNEL: 'Tunnel', PYLONS: 'Pylône', CBLOHD: 'Câble aérien', cblohd: 'Câble aérien',
  FAIRWY: 'Chenal', NAVLNE: 'Ligne de navigation', RECTRC: 'Route recommandée', TSSLPT: 'DST (voie)',
  TSSBND: 'DST (limite)', TSEZNE: 'DST (zone de séparation)', RESARE: 'Zone réglementée',
  resare: 'Zone réglementée', ACHARE: 'Zone de mouillage', achare: 'Zone de mouillage', achbrt: 'Poste de mouillage',
  PRCARE: 'Zone de précaution', CTNARE: 'Zone de prudence', MIPARE: 'Zone militaire', SPLARE: 'Zone hydravions',
  FERYRT: 'Route de bac', MARCUL: 'Culture marine', CBLSUB: 'Câble sous-marin', CBLARE: 'Zone de câbles',
  PIPSOL: 'Conduite sous-marine', PIPARE: 'Zone de conduites', DMPGRD: 'Zone de dépôt',
  BOYLAT: 'Bouée latérale', BOYCAR: 'Bouée cardinale', BOYISD: 'Bouée de danger isolé',
  BOYSAW: 'Bouée d’eaux saines', BOYSPP: 'Bouée spéciale', BCNLAT: 'Balise latérale', BCNCAR: 'Balise cardinale',
  BCNISD: 'Balise de danger isolé', BCNSAW: 'Balise d’eaux saines', BCNSPP: 'Balise spéciale',
  LIGHTS: 'Feu', TOPMAR: 'Voyant', DAYMAR: 'Marque de jour', FOGSIG: 'Signal de brume',
  RTPBCN: 'Balise radar', RADRFL: 'Réflecteur radar', WRECKS: 'Épave', OBSTRN: 'Obstruction',
  UWTROC: 'Roche', PILPNT: 'Pieu', HRBFAC: 'Installation portuaire', hrbfac: 'Installation portuaire',
  SMCFAC: 'Installation de plaisance', BERTHS: 'Poste à quai', berths: 'Poste à quai', MORFAC: 'Ouvrage d’amarrage',
  OFSPLF: 'Plateforme', hrbare: 'Port', hrbbsn: 'Bassin', termnl: 'Terminal', bunsta: 'Avitaillement',
  CGUSTA: 'Garde-côtes', RSCSTA: 'Station de sauvetage', PILBOP: 'Pilotes', wtwaxs: 'Axe de voie navigable',
  wtwprf: 'Profil de voie navigable', notmrk: 'Panneau de signalisation', comare: 'Zone de communication',
  trnbsn: 'Bassin d’évitage', rdocal: 'Point d’appel VHF', RDOCAL: 'Point d’appel VHF', lokare: 'Zone d’écluse',
  exceed: 'Dépassement', sistat: 'Station de signalisation', sistaw: 'Signalisation', dismar: 'Borne kilométrique',
  lkbspt: 'Partie de sas', SOUNDG: 'Sonde',
};

const COLOUR: Record<string, string> = {
  '1': 'blanc', '2': 'noir', '3': 'rouge', '4': 'vert', '5': 'bleu', '6': 'jaune', '7': 'gris',
  '8': 'brun', '9': 'ambre', '10': 'violet', '11': 'orange', '12': 'magenta', '13': 'rose',
};
export const COLOUR_HEX: Record<string, string> = {
  '1': '#ffffff', '2': '#1a1a1a', '3': '#e32020', '4': '#1f9e3a', '5': '#1f5fd0', '6': '#f2c700',
  '7': '#9a9a9a', '8': '#8a5a2b', '9': '#ffb000', '10': '#8a3ffc', '11': '#ff7a00', '12': '#d000c8', '13': '#ff8fc8',
};
const LIGHT_LETTER: Record<string, string> = { '1': 'W', '3': 'R', '4': 'G', '5': 'Bu', '6': 'Y', '10': 'Vi', '11': 'Or' };
export const LITCHR: Record<string, string> = {
  '1': 'F', '2': 'Fl', '3': 'LFl', '4': 'Q', '5': 'VQ', '6': 'UQ', '7': 'Iso', '8': 'Oc', '9': 'IQ',
  '10': 'IVQ', '11': 'IUQ', '12': 'Mo', '13': 'FFl', '14': 'Fl+LFl', '15': 'Oc+Fl', '16': 'FLFl',
  '17': 'Al.Oc', '18': 'Al.LFl', '19': 'Al.Fl', '20': 'Al.Gr', '25': 'Q+LFl', '26': 'VQ+LFl',
  '27': 'UQ+LFl', '28': 'Al', '29': 'Al.FFl',
};
const COLPAT: Record<string, string> = {
  '1': 'bandes horizontales', '2': 'bandes verticales', '3': 'bandes diagonales', '4': 'damier',
  '5': 'bandes', '6': 'bordure',
};
const BOYSHP: Record<string, string> = {
  '1': 'conique', '2': 'cylindrique', '3': 'sphérique', '4': 'à fuseau', '5': 'espar', '6': 'tonneau',
  '7': 'super-bouée', '8': 'bouée à glace',
};
const BCNSHP: Record<string, string> = {
  '1': 'perche', '2': 'balai', '3': 'tourelle', '4': 'treillis', '5': 'pieu', '6': 'cairn', '7': 'flottante',
};
const CATLAM: Record<string, string> = {
  '1': 'bâbord', '2': 'tribord', '3': 'bifurcation, chenal préféré à tribord', '4': 'bifurcation, chenal préféré à bâbord',
};
const CATCAM: Record<string, string> = { '1': 'Nord', '2': 'Est', '3': 'Sud', '4': 'Ouest' };
const WATLEV: Record<string, string> = {
  '1': 'partiellement submergé à PM', '2': 'toujours émergé', '3': 'toujours submergé', '4': 'couvre et découvre',
  '5': 'à fleur d’eau', '6': 'inondable', '7': 'flottant',
};
const CATWRK: Record<string, string> = {
  '1': 'non dangereuse', '2': 'dangereuse', '3': 'débris', '4': 'mât(s) visible(s)', '5': 'coque visible',
};
const CATBRG: Record<string, string> = {
  '1': 'fixe', '2': 'mobile', '3': 'tournant', '4': 'levant', '5': 'basculant', '6': 'flottant', '7': 'pont-levis',
  '8': 'transbordeur', '9': 'passerelle', '10': 'viaduc', '11': 'pont-canal', '12': 'suspendu',
};

const list = (v: unknown, dict: Record<string, string>) =>
  v == null ? undefined : String(v).split(',').map((c) => dict[c.trim()] ?? c).join(', ');

const m = (v: unknown) => (v == null ? undefined : `${Number(v).toLocaleString('fr-BE')} m`);

/** Libellé abrégé d'un feu, à la manière des cartes : « Fl(2)G 10s ». */
export function lightLabel(p: Props): string {
  const chr = LITCHR[String(p.LITCHR ?? '')] ?? '';
  const grp = p.SIGGRP && !['()', '(1)'].includes(String(p.SIGGRP)) ? String(p.SIGGRP) : '';
  const col = p.COLOUR ? String(p.COLOUR).split(',').map((c) => LIGHT_LETTER[c] ?? '').join('') : '';
  const per = p.SIGPER ? ` ${p.SIGPER}s` : '';
  const rng = p.VALNMR ? ` ${p.VALNMR}M` : '';
  return `${chr}${grp}${chr === 'F' ? ' ' : ''}${col}${per}${rng}`.trim();
}

/** Lignes clé/valeur à afficher dans le popup d'identification. */
export function describe(p: Props): { title: string; rows: [string, string][] } {
  const objl = String(p.objl ?? '');
  const title = CLASS_NAMES[objl] ?? objl;
  const rows: [string, string | undefined][] = [
    ['Nom', (p.OBJNAM ?? p.NOBJNM) as string | undefined],
    ['Type', objl === 'BOYLAT' || objl === 'BCNLAT' ? list(p.CATLAM, CATLAM) : undefined],
    ['Cardinale', list(p.CATCAM, CATCAM)],
    ['Forme', list(p.BOYSHP, BOYSHP) ?? list(p.BCNSHP, BCNSHP)],
    ['Couleur', list(p.COLOUR, COLOUR)],
    ['Motif', list(p.COLPAT, COLPAT)],
    ['Feu', objl === 'LIGHTS' ? lightLabel(p) : undefined],
    ['Hauteur du feu', m(p.HEIGHT)],
    ['Secteur', p.SECTR1 != null && p.SECTR2 != null ? `${p.SECTR1}° – ${p.SECTR2}°` : undefined],
    ['Profondeur', p.DRVAL1 != null ? (p.DRVAL2 != null ? `${m(p.DRVAL1)} à ${m(p.DRVAL2)}` : `${m(p.DRVAL1)} et plus`) : undefined],
    ['Isobathe', m(p.VALDCO)],
    ['Sonde', p.VALSOU != null ? m(p.VALSOU) : p.depth != null ? m(p.depth) : undefined],
    ['Niveau d’eau', list(p.WATLEV, WATLEV)],
    ['Épave', list(p.CATWRK, CATWRK)],
    ['Pont', list(p.catbrg, CATBRG)],
    ['Tirant d’air', m(p.VERCLR)],
    ['Tirant d’air fermé', m(p.VERCCL)],
    ['Tirant d’air ouvert', m(p.VERCOP)],
    ['Largeur', m(p.HORCLR ?? p.horclw ?? p.HORWID)],
    ['Longueur', m(p.horcll ?? p.HORLEN)],
    ['Saison', p.PERSTA || p.PEREND ? `${fmtPeriod(p.PERSTA)} → ${fmtPeriod(p.PEREND)}` : undefined],
    ['Info', (p.INFORM ?? undefined) as string | undefined],
    ['Info (NL)', (p.NINFOM ?? undefined) as string | undefined],
  ];
  return { title, rows: rows.filter((r): r is [string, string] => r[1] != null && r[1] !== '') };
}

// PERSTA/PEREND : CCYYMMDD ou --MMDD (période annuelle)
function fmtPeriod(v: unknown): string {
  const s = String(v ?? '');
  const mm = s.slice(-4, -2), dd = s.slice(-2);
  return mm && dd ? `${dd}/${mm}` : '?';
}
