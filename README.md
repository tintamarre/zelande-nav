# Zélande Nav

PWA de navigation à voile pour la Zélande (Pays-Bas) : cartes officielles gratuites Rijkswaterstaat (Inland ENC « Zeeland met Diepte », CC-0), position GPS, contour de sécurité, balisage, alarme hauts-fonds, trace GPX, journal de bord (notes horodatées et géolocalisées, export GPX et Markdown), repères personnels (mouillage, danger, info) posés au GPS ou par appui long, partageables par lien. Fonctionne **en ligne** (navigateur) et **hors-ligne** une fois installée sur le téléphone (« Ajouter à l'écran d'accueil »).

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
uv run python -I -W ignore src/northsea.py data/zeeland \
    --cache data/ns -o data/ns-out                                       # couche mer du Nord (~3 min, ~2,5 Go de RAM)
uv run python -I -W ignore src/enc2pmtiles.py data/zeeland \
    -o ../public/tiles/zeeland.pmtiles --meta data/zeeland.json \
    --extra data/ns-out                                                  # ~4 min, ~90 Mo
uv run python -I src/inspect_cells.py data/zeeland                      # inventaire : échelles, emprise, zéro
uv run python -I src/tides.py -o ../public/tiles/tides.json             # marées officielles (30 jours)
uv run python -I src/harmonics.py                                       # constantes des ports voisins (rare, ~1 an de mesures IOC)
uv run python -I -W ignore src/currents.py data/zeeland \
    --tides ../public/tiles/tides.json -o ../public/tiles/currents.json # grille de courants estimés (~2 min)
cp data/ns-out/current_points.json ../public/tiles/ns-current-points.json
uv run python -I src/seacurrents.py --points ../public/tiles/ns-current-points.json \
    -o ../public/tiles/seacurrents.json                                  # courants mer du Nord (modèle, 5 jours)
```

Sans `--extra`, la carte se limite à l'IENC Zélande (~50 Mo).

`enc2pmtiles.py` écrit aussi `zeeland.json` (manifeste : taille, empreinte, date d'édition) que l'app lit pour afficher l'édition et proposer les mises à jour.

## Lancer l'app

```sh
npm ci
npm run dev        # http://localhost:5173 (et sur le réseau local, pour tester sur le téléphone)
npm run build      # dist/ statique, à servir avec le support des requêtes HTTP Range
npm run preview
```

Le GPS du navigateur exige HTTPS (ou `localhost`). Pour tester sur un téléphone en local, passer par un tunnel HTTPS ou par le déploiement Pages.

`VITE_CHART_BASE` (optionnel, au build) : URL d'un dossier contenant `zeeland.pmtiles`, `zeeland.json`, `tides.json`, `currents.json` et `seacurrents.json` si les données sont hébergées ailleurs que l'app (R2, S3… avec CORS et Range).

## Déploiement

`.github/workflows/deploy.yml` : à chaque push et chaque jour à 05:17 UTC, lit la date d'édition dans le catalogue, régénère la carte si elle a changé (cache par édition), construit l'app et publie le tout sur GitHub Pages. Activer Pages dans le dépôt (Settings → Pages → Source : GitHub Actions). Pages sur un dépôt privé demande un plan payant.

## Hors-ligne

- Le service worker (vite-plugin-pwa) met en cache l'app, les polices et les icônes.
- La carte se télécharge explicitement (bouton ⬇, ~90 Mo) dans le Cache Storage ; elle est lue par tranches (`Blob.slice`) sans réseau. Une seule édition est gardée ; l'app signale quand une plus récente est publiée.
- Sans téléchargement, la carte est lue en ligne par requêtes Range.

## Mer du Nord (couche indicative)

Rijkswaterstaat ne publie pas d'IENC pour la mer du Nord, et les cartes marines officielles NL, BE et UK ne sont pas libres. `pipeline/src/northsea.py` complète donc la carte au large (0,5–4,6 °E × 50,6–52,3 °N, de Boulogne et de l'estuaire de la Tamise aux abords de Rotterdam), uniquement là où l'IENC ne dessine rien :

- terre et mer : trait de côte OpenStreetMap (orienté terre à gauche), pour ne pas confondre polders et estran ;
- profondeurs : EMODnet Bathymetry DTM (CC-BY 4.0, maille ~115 m, ≈ zéro des cartes LAT), zones et isobathes tracées sur le minimum 3 × 3 de la grille (prudence) avec toutes les isobathes possibles du contour de sécurité, sondes = la moins profonde de chaque bloc de ~460 m ;
- balisage, feux, voyants, épaves, éoliennes, câbles, rails de trafic : OpenStreetMap (ODbL), tags `seamark` traduits en classes et codes S-57, en mer seulement.

Les objets sont fusionnés dans le même PMTiles (couches `enc` et `soundg`, propriété `src: "ns"`) : style, popup (qui affiche la source), alarme hauts-fonds et hors-ligne fonctionnent sans code spécifique. Eaux intérieures hors Zélande (port de Rotterdam, Haringvliet) non couvertes. Les téléchargements bruts sont gardés dans `data/ns` (cache mensuel en CI).

## Couches optionnelles

- **Vent** (bouton vent de la barre d'outils) : prévision KNMI HARMONIE via Open-Meteo (CC-BY 4.0), grille de 0,15° sur la Zélande et la mer du Nord voisine, interpolée pour afficher des flèches à tout zoom ; bandeau avec force, rafales, Beaufort, tendance sur 3 h et allure/amure d'après le cap fond. La dernière prévision est gardée sur l'appareil (consultation hors-ligne). Pas de flèche hors de la grille de prévision.
- **Courants de marée** (bouton vagues) : **estimation indicative** façon atlas de courants, pas un modèle hydrodynamique.
  - `pipeline/src/tides.py` : marée astronomique officielle Rijkswaterstaat (Waterwebservices DDL 2.0, `WATHTE` / `astronomisch`) de 8 stations (Westkapelle, Vlissingen, Terneuzen, Hansweert, Roompot, Stavenisse, Yerseke, Krammer) sur 30 jours → pleines/basses mers et marnage moyen (`tides.json`, recalculé chaque jour par la CI).
  - `pipeline/src/currents.py` : grille d'environ 900 m sur les eaux reliées à la mer sans ouvrage (sas, portes, barrages retirés : Veerse Meer, Grevelingen, Volkerak-Zoommeer et canaux exclus), direction du flot le long de l'axe des voies navigables orientée vers l'amont de l'onde de marée, vitesse maximale par bassin modulée par la profondeur, réduite hors chenal et dans les ports (`currents.json`).
  - App : flot de l'étale de basse mer à l'étale de pleine mer (étale ≈ 35 min après PM/BM locale), demi-sinusoïde entre deux étales, modulée par le marnage du jour (vives-eaux / mortes-eaux) ; bandeau avec courant au bateau, prochaine étale, prochaines PM/BM. Données gardées pour le hors-ligne.
  - Mer du Nord (hors carte officielle) : au large, la marée se propage le long de la côte et le courant tourne environ 3 h après la pleine mer, ce que le modèle d'atlas ne reproduit pas. On y affiche la **prévision du modèle Mercator SMOC** (Copernicus Marine, maille 1/12° ≈ 8 km, marée + vent + circulation), servie par l'API marine d'Open-Meteo (CC-BY 4.0) : `northsea.py` choisit les mailles en mer à plus de ~1 km de la côte (`ns-current-points.json`), `seacurrents.py` en récupère chaque jour en CI la série horaire de la veille à J+4 (`seacurrents.json`), interpolée à l'heure du curseur par l'app. Limite mesurée : comparée aux stations Rijkswaterstaat, la marée du modèle est en avance de 25 à 45 min et son marnage sous-estimé (15 à 55 %) ; elle n'est donc pas utilisée pour les heures de pleine et basse mer, et l'app le signale dans « À propos ».
- **Marées des ports voisins** (Boulogne, Calais, Dunkerque, Nieuport, Ostende, Zeebrugge, Westhinder, Hastings, Douvres, Deal, Herne Bay, Sheerness, Harwich) : les prédictions du SHOM, de l'UKHO et de la Vlaamse Hydrografie ne sont pas libres, mais les mesures de leurs marégraphes le sont (réseau IOC Sea Level Station Monitoring Facility). `pipeline/src/harmonics.py` refait l'analyse harmonique d'un an de mesures (utide, ~60 composantes) et écrit les constantes dans `pipeline/harmonics.json` (versionné, à refaire environ une fois par an) ; `tides.py` en tire chaque jour les PM/BM. Hauteurs au-dessus de la plus basse mer astronomique sur 19 ans (≈ zéro des cartes, « m ZC »). Contrôle sur Vlissingen contre la prédiction officielle : écart d'heure médian 1 min, moyen 10 min, maximal 33 min ; marnage 3,65 m contre 3,62 m.
- Vent et courant partagent le curseur horaire (−6 h à +72 h, « Maintenant » suit l'heure courante).

## Mobile

L'app est une PWA installable (Android : Chrome → « Installer l'application » ; iOS : Safari → Partager → « Sur l'écran d'accueil »). Utiliser **Chrome** sur Android : Firefox Android peut ne transmettre qu'une position réseau approximative (±1-2 km) même avec la permission « position exacte » ; l'app suspend alors l'alarme hauts-fonds et le signale (diagnostic dans « À propos »). Limites connues : pas de GPS en arrière-plan écran éteint (l'app garde l'écran allumé pendant le suivi via Wake Lock). Pour le GPS en arrière-plan ou une diffusion sur les stores, envelopper l'app avec Capacitor (les chemins sont déjà relatifs, `base: './'`).
