# Brief — App de navigation à voile pour la Zélande (NL)

> Input pour une session Claude Code. Rédigé le 20/10/2026 après un test de faisabilité.
> Kit joint : `scripts/` (téléchargement + conversion), `index.html` (prototype de rendu), `out/render-test.png`.

## 1. Objectif

Une PWA (web + mobile, installable, **hors-ligne**) qui affiche les cartes officielles gratuites de la Zélande
(Oosterschelde, Veerse Meer, Grevelingen, Westerschelde à confirmer), la position GPS du bateau,
et les informations utiles à un voilier : profondeurs, balisage, dangers, ponts/écluses, marées.

**Hors scope v1** : routage, AIS, partie mer du Nord (cartes Dienst der Hydrografie sous licence, voir §3).

## 2. Ce qui a été testé et validé

| Étape | Résultat |
|---|---|
| Catalogue des éditions IENC | ✅ `NL_IENC_Catalog.xml` (OpenCPN, régénéré chaque jour) → « Zeeland met Diepte – 2026 – Week 43 – 47 MB », publiée le 20/10/2026 08:43 UTC |
| Téléchargement du ZIP Zélande | ⚠️ **Non testé** : `vaarweginformatie.nl` bloqué depuis le serveur de test. À lancer en local en premier (`fetch_ienc.py`) |
| Lecture S-57 | ✅ GDAL 3.12.4 embarqué dans `pyogrio` (pip, sans install système) lit le S-57 et applique les mises à jour `.001…` |
| Conversion → PMTiles | ✅ Directement par le driver PMTiles de GDAL : **pas besoin de tippecanoe**. Cellule de test GDAL (`1B5X02NE.000`) : 22 objets, 6 classes, < 1 s, 6 Ko |
| Rendu MapLibre | ✅ MapLibre GL 5.24 + pmtiles 4.5, servi en HTTP Range : zones de profondeur colorées, trait de côte, ouvrages, isobathes, sondes, échelle en milles, géolocalisation. Voir `out/render-test.png` |

**Limite du test** : la cellule GDAL est minuscule et synthétique. Volume, temps de conversion, taille des tuiles
et rendu du balisage sur la vraie Zélande restent **à mesurer** (étape 1 du plan).

## 3. Sources de données

| Donnée | Source | Licence | Accès |
|---|---|---|---|
| Cartes Inland ENC Zélande (S-57, avec profondeurs, édition hebdo) | Rijkswaterstaat, vaarweginformatie.nl | CC-0 | ZIP via catalogue OpenCPN (`fileId` change chaque semaine, ne pas coder en dur) ; aussi WMS `geo.rijkswaterstaat.nl/.../ENC/mcs_inland/.../WMSServer` |
| Profondeurs de chenal, classification, ponts, écluses | Rijkswaterstaat FIS / vaarweginformatie WFS-WMS | CC-0 | `vaarweginformatie.nl/wfswms/dataservice/1.4/` |
| Hauteurs d'eau observées (et prévisions ?) | Rijkswaterstaat Waterwebservices (`waterwebservices.rijkswaterstaat.nl`, POST JSON) | Open data | Doc historique abandonnée → **vérifier** la doc actuelle sur rijkswaterstaatdata.nl/waterdata ; marée astronomique non confirmée |
| Balisage complémentaire, ports, POI | OpenSeaMap / OpenStreetMap (`seamark:*`) | ODbL (attribution + share-alike sur la base dérivée) | Overpass ou extrait Geofabrik |
| Côte et approches mer du Nord | Dienst der Hydrografie (ENC officielles) | **Sous licence** (UKHO / IC-ENC) | Ne pas intégrer sans accord |

## 4. Pipeline (déjà écrit, à durcir)

```
fetch_ienc.py --area zeeland     # catalogue → ZIP → data/zeeland/*.000 (+ .json avec la date d'édition)
enc2pmtiles.py data/zeeland -o tiles/zeeland.pmtiles --minzoom 8 --maxzoom 16
```

- Une seule couche vectorielle `enc`, la classe S-57 dans `objl` (DEPARE, BOYLAT, LIGHTS…), échelle de compilation dans `cscl`.
- Sondes éclatées en points, profondeur dans `depth`.
- Liste blanche des classes + attributs utiles (`KEEP`, `ATTRS` dans le script), y compris les classes IENC en minuscules (`wtwaxs`, `notmrk`, `bunsta`…).
- **Automatisation** : GitHub Action hebdomadaire (cron) → compare la date d'édition → reconvertit → publie le `.pmtiles` (GitHub Releases ou R2/S3). L'app vérifie la version au démarrage.

## 5. Architecture cible

- **Front** : Vite + TypeScript + MapLibre GL JS + `pmtiles`. PWA (service worker) ; la carte Zélande est téléchargée une fois dans l'app (Cache Storage ou OPFS) pour le hors-ligne. Option Capacitor plus tard si besoin d'un GPS en arrière-plan ou des stores.
- **Pas de backend** en v1 : fichiers statiques (app + `.pmtiles` + polices + sprite).
- **Style** : inspiré S-52, simplifié. Paramètre clé = **contour de sécurité** (tirant d'eau + marge) qui pilote les couleurs de profondeur et l'accentuation des sondes.
- **Bateau** : GeolocateControl, cap/vitesse (COG/SOG) calculés depuis les positions, alerte si la position entre dans une DEPARE < contour de sécurité (test point-dans-polygone sur les features rendues).

## 6. Points d'attention relevés pendant le test

1. **Hauteurs découvrantes** : dans le S-57, les sondes négatives sont des hauteurs au-dessus du zéro (estran). Les afficher soulignées, sans signe moins (convention des cartes), pas « -2.3 ».
2. **Polices hors-ligne** : MapLibre a besoin de glyphs PBF pour les étiquettes (sondes, noms). Aucune source en ligne ne doit être requise : générer et auto-héberger les glyphs (ex. Noto Sans / une serif italique pour les sondes). Le prototype contourne avec des marqueurs HTML : à remplacer.
3. **Symboles** : il n'existe pas de jeu S-52 libre « prêt MapLibre ». Commencer par un sprite maison (bouées latérales/cardinales, phares, épaves) ; ne pas copier les symboles d'OpenCPN sans vérifier leur licence (GPL).
4. **Zéro hydrographique** : vérifier dans les métadonnées (`DSPM_VDAT` / `DSPM_SDAT`) le zéro des profondeurs de la Zélande (LAT attendu) avant de combiner avec les hauteurs d'eau Waterinfo (référencées NAP).
5. **Chevauchements** : plusieurs cellules à échelles différentes se recouvrent. Le script trie par `cscl` ; à valider visuellement et, si besoin, filtrer par `cscl` selon le zoom.
6. **Couverture Westerschelde** : non confirmée. Lister les cellules et leur emprise après le premier téléchargement.
7. **Mention légale** dans l'app : « Ne remplace pas une carte officielle à jour ni la vigilance du chef de bord », date d'édition affichée en permanence. Les bancs bougent (édition hebdo).
8. **Attribution** : « Rijkswaterstaat (CC-0) » + « © OpenStreetMap / OpenSeaMap (ODbL) » si OSM est utilisé.

## 7. Plan pour la session Claude Code

1. **Données réelles** : lancer `fetch_ienc.py --area zeeland`, puis `enc2pmtiles.py`. Mesurer : nombre de cellules, classes présentes, temps, taille du `.pmtiles` par niveau de zoom, emprise (Westerschelde ?), zéro hydrographique. Ajuster `KEEP`/zooms.
2. **Projet front** : scaffolder Vite + TS + MapLibre + pmtiles ; reprendre le style de `index.html`, le rendre paramétrable (contour de sécurité dans les réglages).
3. **Glyphs + sprite** auto-hébergés ; sondes en symbol layer (étiquettes) avec style « découvrant » souligné.
4. **Balisage** : couleurs/formes de BOYLAT, BOYCAR, BCN*, LIGHTS (secteurs plus tard), dangers (WRECKS, OBSTRN, UWTROC). Popup d'identification au tap (OBJNAM, caractéristiques du feu).
5. **Hors-ligne** : service worker, téléchargement explicite « carte Zélande (x Mo) », vérification de version.
6. **Bateau** : suivi GPS, COG/SOG, alerte hauts-fonds, enregistrement de trace (IndexedDB, export GPX).
7. **CI** : GitHub Action hebdo pour régénérer la carte.
8. **Ensuite** : marées (Waterinfo), ponts/écluses (FIS), OpenSeaMap en couche optionnelle.

## 8. Questions ouvertes pour Martin

- Usage personnel, ou public / open source ? Cela décide de l'hébergement des tuiles et de la politique d'attribution.
- Taille du bateau (tirant d'eau, tirant d'air) pour les valeurs par défaut du contour de sécurité et l'alerte ponts.
- PWA seule, ou app installée via les stores (Capacitor) dès le départ ?

## Annexes

- Versions testées : Python 3.13, pyogrio + GDAL 3.12.4, MapLibre GL JS 5.24.0, pmtiles 4.5.0, http-server (Range requis pour PMTiles).
- Lancer le prototype : `npm install maplibre-gl@5 pmtiles@4 http-server && npx http-server -p 8765 .` puis `http://localhost:8765/index.html?src=tiles/zeeland.pmtiles`.
- Sources :
  - Dataset IENC CC-0 : https://data.overheid.nl/dataset/55088-enc-van-nederlandse-binnenwateren
  - Catalogue OpenCPN : https://github.com/chartcatalogs/catalogs/blob/master/NL_IENC_Catalog.xml
  - Profondeurs de chenal (FIS) : https://data.overheid.nl/en/dataset/42614-fis-vnds---fairwayclassification---lijnen
  - Waterwebservices (doc historique) : https://rijkswaterstaat.github.io/wm-ws-dl/ → doc actuelle : https://rijkswaterstaatdata.nl/waterdata/
  - Licences Dienst der Hydrografie : https://www.defensie.nl/onderwerpen/h/hydrografie/distributie-zeekaarten-en-publicaties/aanvragen-hydrografische-data
  - Retour d'usage IENC Zélande (hebdo) : https://www.nautin.nl/wb/pages/navigatie/opencpn/instructiebladen-opencpn/11-enc-kaarten.php
