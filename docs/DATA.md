# Données réelles : mesures du 20/10/2026

Édition « Zeeland met Diepte – 2026 – Week 43 », publiée le 20/10/2026 08:43 UTC (catalogue OpenCPN `NL_IENC_Catalog.xml`).

## Téléchargement

- `vaarweginformatie.nl` accessible sans restriction depuis une connexion ordinaire : ZIP de 47,7 Mo en ~30 s.
- Le ZIP contient `20261020_U7Inland_week 43_NL/ENC_ROOT/1R/…` (un dossier par semaine) + un PDF d'assemblage des cellules.

## Cellules

- **61 cellules**, toutes compilées au **1:2000** (`DSPM_CSCL`) : pas de superposition d'échelles à gérer. Une cellule (`1R768ZBI`) couvre une maille double.
- **Emprise** : 3,13 → 4,53 °E, 51,18 → 51,83 °N. **Le Westerschelde est couvert** (jusqu'à Vlissingen / Terneuzen / frontière belge), ainsi que l'Oosterschelde, le Veerse Meer, le Grevelingen, le Volkerak et le kanaal Gent-Terneuzen. La mer du Nord au large n'est pas couverte (cartes Dienst der Hydrografie sous licence).
- **Zéro hydrographique** : `DSPM_SDAT = 42`, `DSPM_VDAT = 24` (Local datum). Le code 42 est une valeur étendue Inland ENC non documentée dans S-57 de base ; en Zélande, le zéro attendu est le LAT (eaux à marée) et un niveau de référence local pour les lacs fermés. Quatre cellules du kanaal Gent-Terneuzen ont un `M_SDAT` propre : « Kanaalpeil = NAP+2,13 ». **À confirmer** auprès de Rijkswaterstaat avant de combiner avec les hauteurs d'eau Waterinfo (référencées NAP).
- **Classes présentes** : 120 classes, dont tout le balisage (BOYLAT 42 cellules, BOYCAR, BOYSPP, BCN*, LIGHTS 60, TOPMAR), dangers (WRECKS, OBSTRN, UWTROC), ponts IENC (`bridge` avec VERCLR/VERCCL/VERCOP), câbles aériens (`cblohd`), panneaux de signalisation (`notmrk`), postes d'amarrage, VHF (`rdocal`).
- Le balisage saisonnier (bouées de plaisance retirées l'hiver) porte `PERSTA` / `PEREND` : affiché dans le popup.

## Volumes

| | |
|---|---|
| Objets conservés | ~470 000, dont 434 249 sondes |
| Profondeurs | DEPARE par tranches de **0,5 m** jusqu'à 8 m, puis 10, 20, 30, 40, 50 m |
| Isobathes | tous les 0,5 m jusqu'à 8 m, puis 10, 20, 30 m |
| GeoJSON intermédiaire | 457 Mo (DEPARE 293 Mo, DEPCNT 149 Mo) + 76 Mo de sondes |
| Conversion | ~2 min 30 (lecture GDAL ~1 min, tippecanoe ~1 min) |
| PMTiles (zoom 6 → 15) | **49,6 Mo** |

Tailles par zoom (essai avec zoom max 16, avant optimisation) : z8 0,8 Mo · z10 2 Mo · z12 5 Mo · z13 8 Mo · z14 13 Mo · z15 22 Mo · z16 38 Mo. Le zoom 16 a été supprimé : MapLibre agrandit les tuiles z15 (précision ≈ 0,3 m), ce qui suffit pour des données au 1:2000.

## Choix faits

- **tippecanoe plutôt que le driver PMTiles de GDAL** : GDAL (via pyogrio) n'écrit qu'une couche par PMTiles et ne connaît pas de minzoom par objet ; avec 434 000 sondes, il fallait les élaguer par zoom. GDAL reste utilisé pour lire le S-57.
- **Élagage des sondes** : grille imbriquée de 48 px ; à chaque zoom, on garde la sonde la moins profonde de chaque maille (comme une carte papier, qui montre les hauts-fonds en priorité).
- **Minzoom** : terre, profondeurs et côte dès le zoom 6 (vue d’ensemble) ; points sans SCAMIN au zoom 10 ; sinon **SCAMIN → minzoom** : `floor(log2(279 541 132 × cos 51,5° / SCAMIN)) − 1`.
- **Simplification** : 8 unités de tuile aux petits zooms, 4 au zoom 15 (≈ 1,2 m), à comparer à la précision d'un GPS (3 à 5 m).
- Les tranches de 0,5 m sont conservées : elles permettent un contour de sécurité précis (tirant d'eau + pied de pilote).

## Pistes pour alléger

- Découper par bassin (Westerschelde / Oosterschelde / lacs) pour des téléchargements partiels.
- Fusionner les tranches de profondeur aux petits zooms (z8-12) : ~10 Mo de gain.
