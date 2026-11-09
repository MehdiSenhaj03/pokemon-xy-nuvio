#!/usr/bin/env node
// Génère un addon Stremio/Nuvio 100 % statique à partir d'un seul torrent
// contenant tous les épisodes d'une série.
//
//   node build.mjs            -> lit config.json, (re)génère docs/
//   node build.mjs --remap    -> refait la détection automatique des épisodes
//
// Fichiers produits :
//   torrent-info.json  cache de la liste des fichiers du torrent (évite de refetch le magnet)
//   mapping.json       fichier -> saison/épisode (MODIFIABLE à la main)
//   docs/              l'addon à héberger (GitHub Pages, Netlify, ...)

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(ROOT, 'config.json')
const CACHE_FILE = path.join(ROOT, 'torrent-info.json')
const MAPPING_FILE = path.join(ROOT, 'mapping.json')
const DIST = path.join(ROOT, 'docs')

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.webm', '.mov', '.ts', '.wmv', '.flv', '.mpg', '.mpeg'])
const args = new Set(process.argv.slice(2))

// ---------------------------------------------------------------- config

function loadConfig () {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  const need = (k) => { if (!cfg[k]) fail(`config.json : le champ "${k}" est obligatoire.`) }
  need('addonId'); need('addonName'); need('source'); need('seriesName')
  if (cfg.source.includes('COLLE_TON_MAGNET_ICI')) fail('config.json : remplace "source" par ton lien magnet (ou le chemin d\'un fichier .torrent).')
  if (!/^[a-z0-9._-]+$/i.test(cfg.addonId)) fail('config.json : "addonId" ne doit contenir que lettres, chiffres, points, tirets.')
  cfg.imdbId = (cfg.imdbId || '').trim()
  if (cfg.imdbId === 'tt0000000') cfg.imdbId = ''
  if (cfg.imdbId && !/^tt\d+$/.test(cfg.imdbId)) fail('config.json : "imdbId" doit ressembler à tt1234567 (ou être vide).')
  cfg.version ||= '1.0.0'
  cfg.extraTrackers ||= []
  return cfg
}

function fail (msg) {
  console.error('\n✖ ' + msg + '\n')
  process.exit(1)
}

// ---------------------------------------------------------------- torrent

// Décodeur bencode minimal (pour lire un fichier .torrent sans dépendance).
function bdecode (buf) {
  let i = 0
  let infoRange = null
  function next (depth, key) {
    const c = buf[i]
    if (c === 0x69) { // i<int>e
      const end = buf.indexOf(0x65, i)
      const n = Number(buf.toString('ascii', i + 1, end)); i = end + 1; return n
    }
    if (c === 0x6c) { // l...e
      i++; const arr = []
      while (buf[i] !== 0x65) arr.push(next(depth + 1))
      i++; return arr
    }
    if (c === 0x64) { // d...e
      i++; const obj = {}
      while (buf[i] !== 0x65) {
        const k = next(depth + 1).toString('utf8')
        const start = i
        obj[k] = next(depth + 1, k)
        if (depth === 0 && k === 'info') infoRange = [start, i]
      }
      i++; return obj
    }
    // <len>:<bytes>
    const colon = buf.indexOf(0x3a, i)
    const len = Number(buf.toString('ascii', i, colon))
    const s = buf.subarray(colon + 1, colon + 1 + len); i = colon + 1 + len; return s
  }
  const value = next(0)
  return { value, infoRange }
}

function readTorrentFile (file) {
  const buf = fs.readFileSync(file)
  const { value, infoRange } = bdecode(buf)
  if (!value.info || !infoRange) fail(`${file} n'est pas un fichier .torrent valide.`)
  const infoHash = crypto.createHash('sha1').update(buf.subarray(...infoRange)).digest('hex')
  const info = value.info
  const name = (info['name.utf-8'] || info.name).toString('utf8')
  const files = info.files
    ? info.files.map((f, idx) => ({
      idx,
      path: [name, ...(f['path.utf-8'] || f.path).map(p => p.toString('utf8'))].join('/'),
      length: f.length
    }))
    : [{ idx: 0, path: name, length: info.length }]
  const announce = new Set()
  if (value.announce) announce.add(value.announce.toString('utf8'))
  for (const tier of value['announce-list'] || []) for (const t of tier) announce.add(t.toString('utf8'))
  return { infoHash, name, files, announce: [...announce] }
}

async function fetchMagnetMetadata (magnet, extraTrackers) {
  console.log('→ Récupération de la liste des fichiers depuis le magnet (DHT/trackers)…')
  console.log('  (ça peut prendre de quelques secondes à quelques minutes selon le nombre de seeders)')
  const { default: WebTorrent } = await import('webtorrent')
  const client = new WebTorrent()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-addon-'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy()
      reject(new Error('Délai dépassé (5 min) : aucun pair n\'a fourni les métadonnées. Vérifie que le torrent a des seeders, ou utilise un fichier .torrent dans "source".'))
    }, 5 * 60 * 1000)
    client.on('error', (e) => { clearTimeout(timer); client.destroy(); reject(e) })
    const torrent = client.add(magnet, { path: tmp, announce: extraTrackers, deselect: true, destroyStoreOnDestroy: true })
    torrent.on('metadata', () => {
      clearTimeout(timer)
      const info = {
        infoHash: torrent.infoHash,
        name: torrent.name,
        files: torrent.files.map((f, idx) => ({ idx, path: f.path.split(path.sep).join('/'), length: f.length })),
        announce: torrent.announce || []
      }
      client.destroy(() => { fs.rmSync(tmp, { recursive: true, force: true }); resolve(info) })
    })
  })
}

async function getTorrentInfo (cfg) {
  if (fs.existsSync(CACHE_FILE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (cached.source === cfg.source) return cached
  }
  let info
  if (cfg.source.startsWith('magnet:')) {
    info = await fetchMagnetMetadata(cfg.source, cfg.extraTrackers)
    // on garde aussi les trackers présents dans le magnet
    const tr = new URL(cfg.source.replace('magnet:', 'http://x/')).searchParams.getAll('tr')
    info.announce = [...new Set([...tr, ...info.announce])]
  } else {
    const file = path.resolve(ROOT, cfg.source)
    if (!fs.existsSync(file)) fail(`"source" n'est ni un magnet ni un fichier existant : ${cfg.source}`)
    info = readTorrentFile(file)
  }
  info.infoHash = info.infoHash.toLowerCase()
  info.source = cfg.source
  fs.writeFileSync(CACHE_FILE, JSON.stringify(info, null, 2))
  console.log(`✔ Torrent « ${info.name} » : ${info.files.length} fichier(s), infoHash ${info.infoHash}`)
  return info
}

// ---------------------------------------------------------------- épisodes

// Essaie de deviner saison/épisode(s) à partir du chemin d'un fichier.
export function detectEpisode (filePath) {
  const parts = filePath.split('/')
  const base = parts.pop().replace(/\.[^.]+$/, '')
  const dirs = parts.join('/')
  let m

  // S01E02, S1E2, S01.E02, S01E01E02, S01E01-E02, S01E01-02
  m = base.match(/S(\d{1,2})[ ._-]?E(\d{1,4})(?:(?:[ ._-]?E|-)(\d{1,4})(?=[^\da-z]|$))?/i)
  if (m) return range(+m[1], +m[2], m[3] && +m[3])

  // 1x02
  m = base.match(/(?:^|[^\d])(\d{1,2})x(\d{2,3})(?:[^\d]|$)/i)
  if (m) return range(+m[1], +m[2])

  // Saison dans le dossier : "Season 2", "Saison 02", "S02"
  let season = null
  m = dirs.match(/(?:season|saison|temporada|staffel)[ ._-]*(\d{1,2})/i) || dirs.match(/(?:^|[/ ._-])S(\d{1,2})(?:[/ ._-]|$)/i)
  if (m) season = +m[1]

  // Épisode dans le nom : "E05", "Ep 5", "Episode 5", "Épisode 5", " - 05 ", "05 - Titre"
  m = base.match(/(?:^|[^a-z])(?:e|ep|episode|épisode|capitulo|folge)[ ._-]*(\d{1,4})(?!\d)/i) ||
      base.match(/ - (\d{1,4})(?:v\d)?(?:[ ._[(-]|$)/) ||
      base.match(/^(\d{1,4})(?:[ ._-]|$)/)
  if (m) return range(season ?? 1, +m[1])

  return null
}

function range (season, from, to) {
  const out = []
  const end = to && to > from && to - from < 10 ? to : from
  for (let e = from; e <= end; e++) out.push({ season, episode: e })
  return out
}

function buildMapping (info) {
  const episodes = []
  const unmatched = []
  const ignored = []
  for (const f of info.files) {
    const ext = path.extname(f.path).toLowerCase()
    const name = path.basename(f.path)
    if (!VIDEO_EXT.has(ext) || /(^|[^a-z])sample([^a-z]|$)/i.test(name)) { ignored.push(f.path); continue }
    const eps = detectEpisode(f.path)
    if (!eps) { unmatched.push({ fileIdx: f.idx, path: f.path, season: null, episode: null }); continue }
    for (const ep of eps) episodes.push({ fileIdx: f.idx, path: f.path, ...ep })
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode || a.fileIdx - b.fileIdx)
  return { infoHash: info.infoHash, episodes, unmatched, ignored }
}

function loadOrCreateMapping (info) {
  if (!args.has('--remap') && fs.existsSync(MAPPING_FILE)) {
    const m = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'))
    if (m.infoHash === info.infoHash) {
      // les entrées "unmatched" complétées à la main sont prises en compte
      const fixed = (m.unmatched || []).filter(u => Number.isInteger(u.season) && Number.isInteger(u.episode))
      return { ...m, episodes: [...m.episodes, ...fixed] }
    }
    console.log('ℹ mapping.json concerne un autre torrent : régénération.')
  }
  const m = buildMapping(info)
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(m, null, 2))
  console.log(`✔ mapping.json créé : ${m.episodes.length} épisode(s) détecté(s)`)
  return m
}

// ---------------------------------------------------------------- génération

function humanSize (bytes) {
  const u = ['o', 'Ko', 'Mo', 'Go', 'To']
  let i = 0; let n = bytes
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i >= 3 ? 2 : 0)} ${u[i]}`
}

function writeJson (rel, data) {
  const file = path.join(DIST, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data))
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function build (cfg, info, mapping) {
  fs.rmSync(DIST, { recursive: true, force: true })
  fs.mkdirSync(DIST, { recursive: true })

  // Deux façons d'exposer la série (cumulables) :
  //  - imdbId : les flux apparaissent sur la fiche officielle (Cinemeta) de la série.
  //    Si une entrée de mapping.json a un champ "imdb": "S:E", c'est cette numérotation qui est utilisée.
  //  - ownMeta (ou pas d'imdbId) : l'addon fournit sa propre fiche, avec SA numérotation (season/episode)
  //    et les titres/vignettes/dates éventuellement présents dans mapping.json.
  const imdbId = cfg.imdbId
  const ownMeta = !imdbId || Boolean(cfg.ownMeta)
  const ownId = (cfg.ownMetaId || cfg.addonId).replace(/[^a-z0-9]/gi, '')
  const catalogId = `${ownMeta ? ownId : imdbId}-catalog`
  const fromImdb = (kind) => imdbId ? `https://images.metahub.space/${kind}/medium/${imdbId}/img` : ''
  const poster = cfg.poster || fromImdb('poster')
  const background = cfg.background || fromImdb('background')
  const logo = cfg.logo || fromImdb('logo')

  const trackers = [...new Set([...(info.announce || []), ...cfg.extraTrackers])].filter(t => /^(udp|https?):\/\//.test(t))
  const sources = [...trackers.map(t => `tracker:${t}`), `dht:${info.infoHash}`]
  const sizeByIdx = new Map(info.files.map(f => [f.idx, f.length]))

  // --- regroupe les fichiers par épisode, pour chaque identifiant exposé
  const group = (keyOf) => {
    const map = new Map()
    for (const e of mapping.episodes) {
      const key = keyOf(e)
      if (!key) continue
      if (!map.has(key)) map.set(key, [])
      if (!map.get(key).some(x => x.fileIdx === e.fileIdx)) map.get(key).push(e)
    }
    return map
  }
  const ownGroups = ownMeta ? group(e => `${e.season}:${e.episode}`) : new Map()
  const imdbGroups = imdbId ? group(e => ownMeta ? e.imdb : (e.imdb || `${e.season}:${e.episode}`)) : new Map()

  // --- manifest
  const streamPrefixes = [...(ownMeta ? [`${ownId}:`] : []), ...(imdbId ? [`${imdbId}:`] : [])]
  const resources = ['catalog']
  if (ownMeta) resources.push({ name: 'meta', types: ['series'], idPrefixes: [ownId] })
  resources.push({ name: 'stream', types: ['series'], idPrefixes: streamPrefixes })
  const manifest = {
    id: cfg.addonId,
    version: cfg.version,
    name: cfg.addonName,
    description: cfg.description || `${cfg.seriesName} — tous les épisodes.`,
    ...(cfg.logo ? { logo: cfg.logo } : {}),
    ...(background ? { background } : {}),
    resources,
    types: ['series'],
    idPrefixes: [...(ownMeta ? [ownId] : []), ...(imdbId ? [imdbId] : [])],
    catalogs: [{ type: 'series', id: catalogId, name: cfg.addonName }],
    behaviorHints: { configurable: false, p2p: true }
  }
  writeJson('manifest.json', manifest)

  // --- catalogue (la série apparaît sur l'accueil de Nuvio)
  const preview = {
    id: ownMeta ? ownId : imdbId,
    type: 'series',
    name: cfg.seriesName,
    ...(poster ? { poster } : {}),
    ...(background ? { background } : {}),
    ...(logo ? { logo } : {}),
    description: cfg.description || '',
    ...(cfg.genres ? { genres: cfg.genres } : {}),
    ...(cfg.year ? { releaseInfo: String(cfg.year) } : {})
  }
  writeJson(`catalog/series/${catalogId}.json`, { metas: [preview] })

  // --- fiche maison avec la liste des épisodes
  if (ownMeta) {
    const videos = [...ownGroups.entries()].map(([k, files], i) => {
      const [season, episode] = k.split(':').map(Number)
      const e = files[0]
      return {
        id: `${ownId}:${season}:${episode}`,
        title: e.title || (season === 0 ? `Spécial ${episode}` : `Épisode ${episode}`),
        season,
        episode,
        released: e.released || new Date(Date.UTC(2000, 0, 1 + i)).toISOString(),
        ...(e.thumbnail ? { thumbnail: e.thumbnail } : {}),
        ...(e.overview ? { overview: e.overview } : {})
      }
    })
    writeJson(`meta/series/${ownId}.json`, { meta: { ...preview, videos } })
  }

  // --- flux
  const streamsFor = (files) => files.map(e => {
    const filename = path.basename(e.path)
    const size = sizeByIdx.get(e.fileIdx)
    const text = `${filename}\n💾 ${humanSize(size)}`
    return {
      name: `${cfg.addonName}${cfg.streamLabel ? '\n' + cfg.streamLabel : ''}`,
      title: text,
      description: text,
      infoHash: info.infoHash,
      fileIdx: e.fileIdx,
      sources,
      behaviorHints: { bingeGroup: `${cfg.addonId}|${info.infoHash}`, filename, videoSize: size }
    }
  })
  for (const [key, files] of ownGroups) writeJson(`stream/series/${ownId}:${key}.json`, { streams: streamsFor(files) })
  for (const [key, files] of imdbGroups) writeJson(`stream/series/${imdbId}:${key}.json`, { streams: streamsFor(files) })

  // --- page d'installation
  const shown = ownMeta ? ownGroups : imdbGroups
  const epList = [...shown.entries()].map(([k, fs_]) => {
    const [s, e] = k.split(':')
    const label = s === '0' ? `Spécial ${e}` : `S${s.padStart(2, '0')}E${e.padStart(2, '0')}`
    return `<li><b>${label}</b> ${fs_[0].title ? esc(fs_[0].title) + ' — ' : ''}<span>${esc(path.basename(fs_[0].path))}</span></li>`
  }).join('\n')
  fs.writeFileSync(path.join(DIST, 'index.html'), installPage(cfg, epList, shown.size, poster))
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '')

  return { episodes: shown.size, imdbLinked: imdbGroups.size, seriesId: ownMeta ? ownId : imdbId }
}

function installPage (cfg, epList, count, poster) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.addonName)}</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--fg:#e8eaf0;--mut:#9aa0ad;--acc:#7c5cff}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:720px;margin:0 auto;padding:32px 16px}
.head{display:flex;gap:20px;align-items:center}.head img{width:110px;border-radius:10px}
h1{margin:0 0 4px;font-size:28px}p{color:var(--mut);margin:0}
.box{background:var(--card);border-radius:12px;padding:16px;margin-top:24px}
code{display:block;word-break:break-all;background:#0b0d11;padding:10px;border-radius:8px;font-size:14px}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
button,a.btn{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;cursor:pointer;text-decoration:none}
a.btn.alt{background:#2a2f3a}
ol{padding-left:20px;color:var(--mut)}ul{list-style:none;padding:0;margin:0;max-height:360px;overflow:auto}
li{padding:6px 0;border-bottom:1px solid #232733;font-size:14px}li span{color:var(--mut);word-break:break-all}
</style></head><body><main>
<div class="head">${poster ? `<img src="${esc(poster)}" alt="">` : ''}<div><h1>${esc(cfg.addonName)}</h1><p>${esc(cfg.description || cfg.seriesName)}</p><p>${count} épisodes</p></div></div>
<div class="box"><b>Lien de l'addon</b><code id="url"></code>
<div class="btns"><button id="copy">Copier le lien</button><a class="btn alt" id="stremio">Ouvrir dans Stremio</a></div></div>
<div class="box"><b>Installer dans Nuvio</b><ol>
<li>Copie le lien ci-dessus.</li><li>Nuvio → Paramètres → Addons.</li><li>Colle le lien et valide.</li>
<li>Cherche « ${esc(cfg.seriesName)} » ou ouvre-la depuis l'accueil, choisis un épisode, puis la source « ${esc(cfg.addonName)} ».</li></ol></div>
<div class="box"><b>Épisodes</b><ul>${epList}</ul></div>
</main><script>
const u=new URL('manifest.json',location.href).href;document.getElementById('url').textContent=u;
document.getElementById('stremio').href=u.replace(/^https?:/,'stremio:');
document.getElementById('copy').onclick=async e=>{try{await navigator.clipboard.writeText(u);e.target.textContent='Copié ✔'}catch{prompt('Copie ce lien :',u)}};
</script></body></html>`
}

// ---------------------------------------------------------------- main

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig()
  const info = await getTorrentInfo(cfg)
  const mapping = loadOrCreateMapping(info)
  const { episodes, imdbLinked, seriesId } = build(cfg, info, mapping)

  const seasons = {}
  for (const e of mapping.episodes) (seasons[e.season] ||= new Set()).add(e.episode)
  console.log(`\n✔ Addon généré dans docs/ : ${episodes} épisode(s)`)
  for (const [s, set] of Object.entries(seasons)) {
    const eps = [...set].sort((a, b) => a - b)
    const missing = []
    for (let e = 1; e <= eps.at(-1); e++) if (!set.has(e)) missing.push(e)
    console.log(`  Saison ${s} : ${eps.length} épisode(s) (E${eps[0]}→E${eps.at(-1)})${missing.length ? `  ⚠ manquants : ${missing.join(', ')}` : ''}`)
  }
  const pending = (mapping.unmatched || []).filter(u => !Number.isInteger(u.season))
  if (pending.length) {
    console.log(`\n⚠ ${pending.length} fichier(s) vidéo non reconnu(s). Ouvre mapping.json, remplis "season"/"episode" dans "unmatched", puis relance npm run build :`)
    for (const u of pending.slice(0, 15)) console.log('   - ' + u.path)
    if (pending.length > 15) console.log(`   … et ${pending.length - 15} autre(s)`)
  }
  if (!cfg.imdbId || cfg.ownMeta) console.log(`\nℹ Fiche maison fournie par l'addon (id "${seriesId}").`)
  if (cfg.imdbId) console.log(`ℹ ${imdbLinked} épisode(s) aussi rattaché(s) à la fiche IMDb ${cfg.imdbId}.`)
  console.log('\nTeste en local : npm run serve   puis héberge le dossier docs/ (voir README).')
  process.exit(0) // webtorrent peut laisser des sockets ouverts
}
