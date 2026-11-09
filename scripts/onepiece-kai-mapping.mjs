#!/usr/bin/env node
// Génère mapping-onepiecekai.json pour One Piece Kaï.
//   node scripts/onepiece-kai-mapping.mjs [dossier "Pack métadonnées (Plex)"]
//
// Saisons : le découpage officiel en 12 arcs du pack Plex de la release.
// Épisodes : numéro absolu (001 → 133), comme dans les noms de fichiers.
// Avec le dossier du pack (fourni dans le torrent), ajoute résumés, dates et vignettes :
// les images sont converties en JPEG dans assets/onepiecekai/ (publiées avec l'addon).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const base = (cfg.publicUrl || '').replace(/\/+$/, '')
const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'torrent-info-onepiecekai.json'), 'utf8'))
const pack = process.argv[2]
const ASSETS = path.join(ROOT, 'assets', 'onepiecekai')

// S01 = East Blue (1-7) … S12 = Egghead (130+), d'après « Installation métadonnées.txt » du pack.
const ARCS = [[1, 7], [8, 16], [17, 22], [23, 37], [38, 42], [43, 55], [56, 62], [63, 68], [69, 89], [90, 106], [107, 129], [130, 999]]
const seasonOf = (abs) => ARCS.findIndex(([a, b]) => abs >= a && abs <= b) + 1

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']+/g, ' ').trim()
// Coefficient de Dice sur les bigrammes (1 = identiques).
function similarity (a, b) {
  const grams = (s) => { s = norm(s); const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1) } return g }
  const ga = grams(a); const gb = grams(b)
  let inter = 0; let total = 0
  for (const [k, v] of ga) { inter += Math.min(v, gb.get(k) || 0); total += v }
  for (const v of gb.values()) total += v
  return total ? (2 * inter) / total : 0
}

// --- lit les .nfo du pack (titre, résumé, date, vignette)
const nfos = []
if (pack) {
  for (const d of fs.readdirSync(pack).filter(d => /^Saison \d+$/.test(d))) {
    for (const f of fs.readdirSync(path.join(pack, d)).filter(f => f.endsWith('.nfo'))) {
      const x = fs.readFileSync(path.join(pack, d, f), 'utf8')
      const tag = (t) => (x.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1]
      const ep = +tag('episode')
      if (!ep) continue
      const unesc = (s) => (s || '').replace(/&#13;/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      const thumb = path.join(pack, d, f.replace(/\.nfo$/, '-thumb.png'))
      nfos.push({
        ep,
        title: unesc(tag('title')).trim(),
        plot: unesc(tag('plot')).replace(/\n{3,}/g, '\n\n').trim(),
        aired: tag('aired'),
        thumb: fs.existsSync(thumb) ? thumb : null
      })
    }
  }
  fs.rmSync(ASSETS, { recursive: true, force: true })
  fs.mkdirSync(ASSETS, { recursive: true })
  const img = (src, dst, width) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `scale='min(${width},iw)':-2`, '-q:v', '4', dst])
  for (const [src, dst, w] of [['poster.png', 'poster.jpg', 600], ['fanart.jpg', 'background.jpg', 1600]]) {
    if (fs.existsSync(path.join(pack, src))) img(path.join(pack, src), path.join(ASSETS, dst), w)
  }
  if (fs.existsSync(path.join(pack, 'logo.png'))) fs.copyFileSync(path.join(pack, 'logo.png'), path.join(ASSETS, 'logo.png'))
  var convert = (n, src) => { img(src, path.join(ASSETS, `E${String(n).padStart(3, '0')}.jpg`), 640); return `${base}/assets/onepiecekai/E${String(n).padStart(3, '0')}.jpg` }
}

const episodes = []; const ignored = []; const unmatched = []
let withDetails = 0
for (const f of info.files) {
  if (!/\.(mkv|mp4)$/i.test(f.path)) { ignored.push(f.path); continue }
  const m = path.basename(f.path).match(/^One Piece \S+ - (\d{3}) - (.+?) - (\d{3,4}p)\.([A-Z]+)\./)
  if (!m) { unmatched.push({ fileIdx: f.idx, path: f.path, season: null, episode: null }); continue }
  const abs = +m[1]
  const fileTitle = m[2].replace(/\s+/g, ' ').trim()
  // Le pack a des noms de fichiers (et parfois des numéros) décalés : on associe par titre
  // quasi identique, sinon par numéro avec un titre ressemblant.
  const scored = nfos.map(n => ({ n, s: similarity(n.title, fileTitle) })).sort((a, b) => b.s - a.s)
  const d = (scored[0] && scored[0].s >= 0.8 && (!scored[1] || scored[1].s < scored[0].s) ? scored[0].n : null) ||
    nfos.find(n => n.ep === abs && similarity(n.title, fileTitle) >= 0.5)
  if (d) withDetails++
  episodes.push({
    fileIdx: f.idx,
    path: f.path,
    season: seasonOf(abs),
    episode: abs,
    title: fileTitle,
    label: `${m[3]} ${m[4]}`,
    ...(d?.plot ? { overview: d.plot } : {}),
    ...(d?.aired ? { released: new Date(d.aired + 'T12:00:00Z').toISOString() } : {}),
    ...(d?.thumb && convert ? { thumbnail: convert(abs, d.thumb) } : {})
  })
}
episodes.sort((a, b) => a.episode - b.episode)

fs.writeFileSync(path.join(ROOT, 'mapping-onepiecekai.json'), JSON.stringify({ infoHash: info.infoHash, episodes, unmatched, ignored }, null, 2))
const perSeason = {}
for (const e of episodes) perSeason[e.season] = (perSeason[e.season] || 0) + 1
console.log(`${episodes.length} épisodes (${withDetails} avec résumé/vignette), saisons :`, perSeason, unmatched.length ? `⚠ ${unmatched.length} non reconnus` : '')
const missing = episodes.filter(e => !e.overview).map(e => e.episode)
if (missing.length) console.log('Sans résumé :', missing.join(', '))
