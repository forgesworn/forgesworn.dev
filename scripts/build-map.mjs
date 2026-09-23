#!/usr/bin/env node
// Build the ForgeSworn ecosystem map from map/ecosystem.txt.
//
// Writes map/ecosystem-map.html (self-contained: fonts and icons inlined) and,
// unless --html-only is given, renders map/ecosystem-map.png from it with a
// headless browser. The text file is the source; both outputs are derived.
//
//   node scripts/build-map.mjs              HTML + PNG
//   node scripts/build-map.mjs --html-only  HTML only
//   node scripts/build-map.mjs --strict     fail on names outside the catalogue

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mapDir = join(root, 'map')
const args = new Set(process.argv.slice(2))

const COLOURS = {
  gold: '#e8a838',
  amber: '#f59e0b',
  blue: '#4a9eff',
  green: '#34d399',
  teal: '#2dd4bf',
  red: '#f87171',
  rose: '#fb7185',
  purple: '#a78bfa',
}

export function parseMap(text) {
  const meta = {}
  const sections = []
  let current = null
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line || (line.startsWith('#') && !line.startsWith('##'))) return
    const where = `ecosystem.txt:${i + 1}`
    if (line.startsWith('##')) {
      const [title, colour = 'gold'] = line.slice(2).split('|').map((s) => s.trim())
      const hex = COLOURS[colour] ?? (/^#[0-9a-f]{3,8}$/i.test(colour) ? colour : null)
      if (!title) throw new Error(`${where}: section needs a title`)
      if (!hex) throw new Error(`${where}: unknown colour "${colour}"`)
      current = { title, colour: hex, entries: [] }
      sections.push(current)
      return
    }
    if (!current) {
      const m = line.match(/^([a-z]+)\s*:\s*(.*)$/i)
      if (!m) throw new Error(`${where}: expected "key: value" before the first section`)
      meta[m[1].toLowerCase()] = m[2]
      return
    }
    const [name, label] = line.split('=').map((s) => s.trim())
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`${where}: bad repo name "${name}"`)
    current.entries.push({ name, label: label || name })
  })
  return { meta, sections }
}

function knownRepos() {
  const path = join(root, 'forgesworn-repos.json')
  if (!existsSync(path)) return null
  const cat = JSON.parse(readFileSync(path, 'utf8'))
  const names = new Set()
  for (const c of cat.categories ?? []) for (const r of c.repos ?? c.projects ?? []) names.add(r.name)
  for (const r of cat.excludedPublicRepos ?? []) names.add(r.name)
  return names
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function monogram(label) {
  const words = label.replace(/[()]/g, '').split(/[\s._-]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : label.replace(/[^a-z0-9]/gi, '').slice(0, 2)
  return /^\d/.test(letters) ? letters : letters[0].toUpperCase() + (letters[1] ?? '').toLowerCase()
}

function tile(entry, colour) {
  const iconPath = join(mapDir, 'icons', `${entry.name}.svg`)
  const inner = existsSync(iconPath)
    ? `<img alt="" src="data:image/svg+xml;base64,${readFileSync(iconPath).toString('base64')}">`
    : `<span class="mono" style="--c:${colour}">${esc(monogram(entry.label))}</span>`
  return `<figure class="tile"><div class="icon" style="--c:${colour}">${inner}</div><figcaption>${esc(entry.label)}</figcaption></figure>`
}

function font(file) {
  return `data:font/woff2;base64,${readFileSync(join(root, 'site', 'fonts', file)).toString('base64')}`
}

export function renderHtml({ meta, sections }) {
  const body = sections
    .map((s) => {
      const n = s.entries.length
      return `<section style="--c:${s.colour};--n:${n};flex-grow:${n}">
  <h2>${esc(s.title)}</h2>
  <div class="tiles">${s.entries.map((e) => tile(e, s.colour)).join('')}</div>
</section>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>${esc(meta.title ?? 'ForgeSworn')} ${esc(meta.subtitle ?? 'Ecosystem Map')}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
@font-face { font-family: Fraunces; src: url(${font('fraunces-latin.woff2')}) format("woff2"); font-weight: 300 700; }
@font-face { font-family: Inter; src: url(${font('inter-latin.woff2')}) format("woff2"); font-weight: 400 600; }
@font-face { font-family: "JetBrains Mono"; src: url(${font('jetbrains-mono-latin.woff2')}) format("woff2"); font-weight: 400 700; }
:root { --bg: #0a0a0f; --card: #111118; --text: #e8e6e3; --muted: #9896a1; --gold: #e8a838; }
* { box-sizing: border-box; margin: 0; }
html, body { background: var(--bg); color: var(--text); }
.map {
  width: 1400px; padding: 64px 56px 48px;
  background:
    radial-gradient(1200px 600px at 15% -10%, rgba(232,168,56,.14), transparent 60%),
    radial-gradient(900px 700px at 100% 100%, rgba(74,158,255,.10), transparent 60%),
    var(--bg);
}
header { display: flex; align-items: flex-end; gap: 28px; margin: 0 0 44px 8px; }
header .mark { width: 96px; height: 96px; flex: none; }
header h1 {
  font-family: Fraunces, Georgia, serif; font-variation-settings: "opsz" 144;
  font-weight: 600; font-size: 76px; line-height: .98; letter-spacing: -.02em;
}
header h1 span { display: block; color: var(--gold); }
header .ver { font-family: "JetBrains Mono", monospace; font-size: 18px; color: var(--muted); margin-left: 10px; }
.grid { display: flex; flex-wrap: wrap; gap: 30px 18px; }
section {
  position: relative; flex-basis: calc(min(var(--n), 7) * 98px + 40px);
  display: flex; flex-direction: column; justify-content: center;
  border: 1.5px solid color-mix(in srgb, var(--c) 70%, transparent); border-radius: 14px;
  background: color-mix(in srgb, var(--card) 88%, var(--c) 12%);
  padding: 30px 18px 16px;
}
h2 {
  position: absolute; top: 0; left: 50%; transform: translate(-50%, -50%); white-space: nowrap;
  background: var(--c); color: #0a0a0f; border-radius: 6px; padding: 4px 12px;
  font-family: "JetBrains Mono", monospace; font-size: 13px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase;
}
.tiles { display: flex; flex-wrap: wrap; justify-content: space-evenly; gap: 14px 0; }
.tile { width: 98px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.icon {
  width: 60px; height: 60px; border-radius: 50%; display: grid; place-items: center; overflow: hidden;
  background: #0d0d14; box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 45%, transparent);
}
.icon img { width: 40px; height: 40px; }
.mono {
  width: 100%; height: 100%; display: grid; place-items: center;
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--c) 85%, white 15%), color-mix(in srgb, var(--c) 55%, #0a0a0f));
  color: #0a0a0f; font-family: Fraunces, Georgia, serif; font-variation-settings: "opsz" 48;
  font-weight: 700; font-size: 24px; letter-spacing: -.02em;
}
figcaption {
  font-family: Inter, sans-serif; font-size: 12.5px; font-weight: 500; line-height: 1.25;
  text-align: center; color: var(--text);
}
footer {
  margin-top: 48px; text-align: center;
  font-family: Fraunces, Georgia, serif; font-variation-settings: "opsz" 72;
  font-size: 40px; font-weight: 600; color: var(--gold);
}
</style>
</head>
<body>
<main class="map">
<header>
  <svg class="mark" viewBox="0 0 96 96" aria-hidden="true">
    <rect x="2" y="2" width="92" height="92" rx="22" fill="#14141d" stroke="#e8a838" stroke-width="3"/>
    <path transform="translate(16 14) scale(2.67)" d="M4 18h16v2H4v-2zm2-2h12l1-4H5l1 4zm3-6h6l0.5-2h-7l0.5 2zm2-4h2V4h-2v2z" fill="#e8a838"/>
  </svg>
  <h1>${esc(meta.title ?? 'ForgeSworn')}<span>${esc(meta.subtitle ?? 'Ecosystem Map')}<small class="ver">${esc(meta.version ?? '')}</small></span></h1>
</header>
<div class="grid">
${body}
</div>
${meta.footer ? `<footer>${esc(meta.footer)}</footer>` : ''}
</main>
</body>
</html>
`
}

async function renderPng(htmlPath, pngPath) {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    throw new Error('PNG needs playwright (npm i -D playwright), or pass --html-only')
  }
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 })
    await page.goto(pathToFileURL(htmlPath).href)
    await page.evaluate(() => document.fonts.ready)
    await page.locator('.map').screenshot({ path: pngPath })
  } finally {
    await browser.close()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const map = parseMap(readFileSync(join(mapDir, 'ecosystem.txt'), 'utf8'))

  const known = knownRepos()
  const seen = new Set()
  const problems = []
  for (const s of map.sections)
    for (const e of s.entries) {
      if (seen.has(e.name)) problems.push(`${e.name} appears twice`)
      seen.add(e.name)
      if (known && !known.has(e.name)) problems.push(`${e.name} is not in forgesworn-repos.json`)
    }
  for (const p of problems) console.warn(`warning: ${p}`)
  if (problems.length && args.has('--strict')) process.exit(1)

  const htmlPath = join(mapDir, 'ecosystem-map.html')
  writeFileSync(htmlPath, renderHtml(map))
  const count = map.sections.reduce((n, s) => n + s.entries.length, 0)
  console.log(`wrote map/ecosystem-map.html (${map.sections.length} sections, ${count} entries)`)

  if (!args.has('--html-only')) {
    await renderPng(htmlPath, join(mapDir, 'ecosystem-map.png'))
    console.log('wrote map/ecosystem-map.png')
  }
}
