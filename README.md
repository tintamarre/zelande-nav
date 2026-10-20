# Zélande Nav

PWA de navigation à voile pour la Zélande (Pays-Bas) : cartes officielles gratuites Rijkswaterstaat (Inland ENC « Zeeland met Diepte », CC-0), position GPS, contour de sécurité, balisage, alarme hauts-fonds, trace GPX. Fonctionne **en ligne** (navigateur) et **hors-ligne** une fois installée sur le téléphone (« Ajouter à l'écran d'accueil »).

> Ne remplace pas une carte officielle à jour ni la vigilance du chef de bord.

Brief initial et résultats du test de faisabilité : [docs/BRIEF.md](docs/BRIEF.md). Mesures sur les données réelles : [docs/DATA.md](docs/DATA.md).

## Structure

```
pipeline/   Python (uv) : téléchargement IENC → conversion PMTiles
src/        App Vite + TypeScript + MapLibre GL + pmtiles
public/     Icônes, polices PBF auto-hébergées (Noto Sans, OFL) ; public/tiles/ = carte générée (non versionnée)
scripts/    Utilitaires (polices, capture d'écran)
.github/    CI : régénération quotidienne de la carte + déploiement GitHub Pages
```

## Prérequis

- Node 22 (`.nvmrc` ; Node 18 ne suffit pas pour le build PWA)
- [uv](https://docs.astral.sh/uv/) et Python 3.13
- [tippecanoe](https://github.com/felt/tippecanoe) ≥ 2.17 (`brew install tippecanoe` ou compilation depuis les sources ; éviter le paquet Ubuntu 24.04 en 2.49, qui produit des tuiles quasi vides)

## Générer la carte

```sh
cd pipeline
uv sync
uv run python -I src/fetch_ienc.py --area zeeland --dest data          # ~47 Mo, 61 cellules S-57
uv run python -I -W ignore src/enc2pmtiles.py data/zeeland \
    -o ../public/tiles/zeeland.pmtiles --meta data/zeeland.json         # ~2 min 30, ~50 Mo
uv run python -I src/inspect_cells.py data/zeeland                      # inventaire : échelles, emprise, zéro
uv run python -I src/tides.py -o ../public/tiles/tides.json             # marées officielles (30 jours)
uv run python -I -W ignore src/currents.py data/zeeland \
    --tides ../public/tiles/tides.json -o ../public/tiles/currents.json # grille de courants estimés (~2 min)
```

`enc2pmtiles.py` écrit aussi `zeeland.json` (manifeste : taille, empreinte, date d'édition) que l'app lit pour afficher l'édition et proposer les mises à jour.

## Lancer l'app

```sh
npm ci
npm run dev        # http://localhost:5173 (et sur le réseau local, pour tester sur le téléphone)
npm run build      # dist/ statique, à servir avec le support des requêtes HTTP Range
npm run preview
```

Le GPS du navigateur exige HTTPS (ou `localhost`). Pour tester sur un téléphone en local, passer par un tunnel HTTPS ou par le déploiement Pages.

`VITE_CHART_BASE` (optionnel, au build) : URL d'un dossier contenant `zeeland.pmtiles`, `zeeland.json`, `tides.json` et `currents.json` si les données sont hébergées ailleurs que l'app (R2, S3… avec CORS et Range).

## Déploiement

`.github/workflows/deploy.yml` : à chaque push et chaque jour à 05:17 UTC, lit la date d'édition dans le catalogue, régénère la carte si elle a changé (cache par édition), construit l'app et publie le tout sur GitHub Pages. Activer Pages dans le dépôt (Settings → Pages → Source : GitHub Actions). Pages sur un dépôt privé demande un plan payant.

## Hors-ligne

- Le service worker (vite-plugin-pwa) met en cache l'app, les polices et les icônes.
- La carte se télécharge explicitement (bouton ⬇, ~50 Mo) dans le Cache Storage ; elle est lue par tranches (`Blob.slice`) sans réseau. Une seule édition est gardée ; l'app signale quand une plus récente est publiée.
- Sans téléchargement, la carte est lue en ligne par requêtes Range.

## Couches optionnelles

- **Vent** (bouton vent de la barre d'outils) : prévision KNMI HARMONIE via Open-Meteo (CC-BY 4.0), grille de 0,1° sur la Zélande, interpolée pour afficher des flèches à tout zoom ; bandeau avec force, rafales, Beaufort, tendance sur 3 h et allure/amure d'après le cap fond. La dernière prévision est gardée sur l'appareil (consultation hors-ligne). Pas de flèche hors de la grille de prévision.
- **Courants de marée** (bouton vagues) : **estimation indicative** façon atlas de courants, pas un modèle hydrodynamique.
  - `pipeline/src/tides.py` : marée astronomique officielle Rijkswaterstaat (Waterwebservices DDL 2.0, `WATHTE` / `astronomisch`) de 8 stations (Westkapelle, Vlissingen, Terneuzen, Hansweert, Roompot, Stavenisse, Yerseke, Krammer) sur 30 jours → pleines/basses mers et marnage moyen (`tides.json`, recalculé chaque jour par la CI).
  - `pipeline/src/currents.py` : grille d'environ 900 m sur les eaux reliées à la mer sans ouvrage (sas, portes, barrages retirés : Veerse Meer, Grevelingen, Volkerak-Zoommeer et canaux exclus), direction du flot le long de l'axe des voies navigables orientée vers l'amont de l'onde de marée, vitesse maximale par bassin modulée par la profondeur, réduite hors chenal et dans les ports (`currents.json`).
  - App : flot de l'étale de basse mer à l'étale de pleine mer (étale ≈ 35 min après PM/BM locale), demi-sinusoïde entre deux étales, modulée par le marnage du jour (vives-eaux / mortes-eaux) ; bandeau avec courant au bateau, prochaine étale, prochaines PM/BM. Données gardées pour le hors-ligne.
- Vent et courant partagent le curseur horaire (−6 h à +72 h, « Maintenant » suit l'heure courante).

## Mobile

L'app est une PWA installable (Android : Chrome → « Installer l'application » ; iOS : Safari → Partager → « Sur l'écran d'accueil »). Utiliser **Chrome** sur Android : Firefox Android peut ne transmettre qu'une position réseau approximative (±1-2 km) même avec la permission « position exacte » ; l'app suspend alors l'alarme hauts-fonds et le signale (diagnostic dans « À propos »). Limites connues : pas de GPS en arrière-plan écran éteint (l'app garde l'écran allumé pendant le suivi via Wake Lock). Pour le GPS en arrière-plan ou une diffusion sur les stores, envelopper l'app avec Capacitor (les chemins sont déjà relatifs, `base: './'`).
