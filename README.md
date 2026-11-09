# Addon Nuvio : des séries depuis des torrents

Ce projet transforme **un ou plusieurs torrents contenant chacun tous les épisodes d'une série** en un
addon compatible Nuvio et Stremio. L'addon est **100 % statique** : ce ne sont que des fichiers JSON.
Tu l'héberges gratuitement sur GitHub Pages et tu partages un simple lien.

Séries actuellement incluses : **Pokémon XY & XYZ** (VO japonaise 1080p, sous-titres FR/EN) et
**One Piece Kaï** (version remontée par des fans, VF/VOSTFR).

## 1. Configurer

`config.json` contient les réglages de l'addon, puis la liste des séries dans `series`.

Réglages de l'addon :

| Champ | Rôle |
|---|---|
| `addonId` | Identifiant unique, ex. `community.monpseudo.anime`. Ne le change plus une fois l'addon partagé. |
| `addonName` | Nom affiché dans Nuvio, à côté des sources |
| `description` / `version` | Description de l'addon ; augmente `version` à chaque mise à jour |
| `publicUrl` | Adresse où l'addon est hébergé (ex. `https://pseudo.github.io/depot`). Obligatoire si tu fournis des sous-titres. |
| `catalogId` | Optionnel : identifiant du catalogue de l'accueil |
| `extraTrackers` | Trackers ajoutés pour trouver plus vite des pairs |

Pour chaque série de `series` :

| Champ | Rôle |
|---|---|
| `source` | Lien `magnet:?xt=...` **ou** chemin d'un fichier `.torrent` (ex. `serie.torrent`) |
| `seriesName` / `description` | Nom et résumé de la série |
| `ownMetaId` | Identifiant de la fiche fournie par l'addon (lettres et chiffres) |
| `imdbId` | Optionnel : ID IMDb (`tt1234567`). Les flux apparaissent alors aussi sur la fiche officielle. |
| `ownMeta` | Avec un `imdbId` : `true` pour fournir quand même la fiche maison, avec la numérotation de ton mapping |
| `poster` / `background` / `logo` | Optionnel : URLs d'images (trouvées automatiquement avec un `imdbId`) |
| `year` / `genres` | Optionnel : affichés sur la fiche |
| `streamLabel` | Petit texte sous le nom de la source, ex. `1080p VF` (un épisode peut avoir son propre `label`) |
| `mapping` / `cache` | Fichiers de correspondance et de cache de la série (par défaut `mapping-<id>.json`, `torrent-info-<id>.json`) |
| `subtitlesDir` | Dossier des sous-titres de la série |

Pour ajouter une série : ajoute un bloc dans `series`, lance `npm run build`, puis corrige son
fichier de mapping si besoin (voir plus bas).

### Sous-titres (optionnel)

Mets des fichiers `.vtt` ou `.srt` dans `subtitles/`, nommés selon la numérotation de `mapping.json` :
`S17E01.fra.vtt`, `S17E01.eng.vtt`… Le build les publie dans `docs/subtitles/` et les attache à chaque
flux de l'épisode. Nuvio les propose alors dans le menu des sous-titres.

## 2. Générer l'addon

```bash
npm install
```

```bash
npm run build
```

Ce que fait le script :
1. Il lit la liste des fichiers du torrent. Avec un magnet, il la récupère auprès des pairs, ce qui
   peut prendre de quelques secondes à quelques minutes. Le résultat est mis en cache dans
   `torrent-info.json`.
2. Il détecte la saison et l'épisode de chaque fichier (`S01E02`, `1x02`, `Saison 2/Episode 03`,
   `Anime - 07`, etc.) et écrit le résultat dans `mapping.json`.
3. Il génère l'addon dans `docs/`.

Il affiche ensuite un résumé par saison, avec les **épisodes manquants** et les **fichiers non reconnus**.

### Corriger la détection

Ouvre `mapping.json` :
- `episodes` : chaque fichier avec sa `season` et son `episode`. Tu peux corriger un numéro.
- `unmatched` : les vidéos non reconnues. Remplis `season` et `episode` (des nombres), ou laisse `null` pour les ignorer.
- `ignored` : fichiers non vidéo et samples.

Champs optionnels par épisode (utilisés pour la fiche maison) : `title`, `released`,
`thumbnail`, `overview`. Avec `ownMeta`, le champ `imdb` (`"16:5"`, soit saison:épisode chez Cinemeta)
rattache aussi le fichier à la fiche IMDb officielle.

Relance `npm run build`. Tes modifications sont conservées. Pour refaire la détection d'une série :
`node build.mjs --remap=<ownMetaId>`. Pour One Piece Kaï, la numérotation par saga est produite par
`node scripts/onepiece-kai-mapping.mjs`.

## 3. Tester en local

```bash
npm run serve
```

Colle dans Nuvio l'adresse `http://192.168.x.x:7000/manifest.json` affichée par la commande.
Le téléphone doit être sur le même Wi-Fi.

## 4. Héberger et partager (GitHub Pages, gratuit)

1. Crée un dépôt GitHub (public) et pousse ce dossier, `docs/` compris :
   ```bash
   git init && git add . && git commit -m "Mon addon" && git branch -M main
   ```
   ```bash
   git remote add origin https://github.com/TON_PSEUDO/TON_DEPOT.git && git push -u origin main
   ```
2. Sur GitHub, va dans **Settings → Pages → Build and deployment** et choisis
   **Deploy from a branch**, branche `main`, dossier **`/docs`**.
3. Une à deux minutes plus tard, ton addon est en ligne :
   - Page d'installation à partager : `https://TON_PSEUDO.github.io/TON_DEPOT/`
   - Lien de l'addon : `https://TON_PSEUDO.github.io/TON_DEPOT/manifest.json`

Dans Nuvio : **Paramètres → Addons**, colle le lien du manifest, puis valide.

> Netlify, Vercel ou Cloudflare Pages marchent aussi : publie simplement le dossier `docs/`.

### Mettre à jour

Modifie `config.json` ou `mapping.json`, puis lance `npm run build` et pousse le résultat.
Pense à augmenter `version` dans `config.json` : Nuvio et Stremio rechargent alors le manifest.
Si tu changes de torrent (`source`), la liste des fichiers est relue automatiquement.

## Lecture des flux

Chaque épisode renvoie un flux torrent standard (`infoHash` + `fileIdx`). Il pointe directement
vers le bon fichier dans le torrent, donc seul cet épisode est téléchargé.
- Nuvio doit pouvoir lire les torrents en P2P (support selon la plateforme), ou passer par un
  service debrid configuré dans l'app.
- La lecture ne marche que si le torrent a des **seeders**. Si tu veux que ça reste fluide pour
  les gens avec qui tu partages, garde-le en seed.

N'utilise et ne partage que du contenu que tu as le droit de diffuser.
