#!/usr/bin/env node
// Petit serveur local pour tester l'addon (docs/) avant de l'héberger.
//   npm run serve  ->  http://<ton-ip-locale>:7000/manifest.json
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs')
const PORT = Number(process.env.PORT) || 7000
const TYPES = { '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8' }

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  let rel
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch { rel = '/' }
  if (rel.endsWith('/')) rel += 'index.html'
  const file = path.join(DIST, path.normalize(rel))
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(rel.startsWith('/stream/') ? 200 : 404, { 'Content-Type': TYPES['.json'] })
    return res.end(rel.startsWith('/stream/') ? '{"streams":[]}' : '{"err":"not found"}')
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
  console.log(req.method, rel)
}).listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
  console.log(`Addon servi sur :`)
  console.log(`  http://localhost:${PORT}/manifest.json`)
  for (const ip of ips) console.log(`  http://${ip}:${PORT}/manifest.json   <- à coller dans Nuvio (même Wi-Fi)`)
})
