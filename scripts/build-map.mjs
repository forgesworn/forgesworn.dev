#!/usr/bin/env node
// Build the ForgeSworn ecosystem map from map/ecosystem.txt.
//
// Writes two self-contained pages (fonts and icons inlined), lays each out in
// a headless browser and serialises the result as a native SVG:
//
//   map/ecosystem-map.html     dark, 1400px wide  ->  .svg  ->  .png
//   map/ecosystem-map-a4.html  light, one A4 page  ->  .svg, and .pdf
//
// The A4 page sizes itself: a small script shrinks or grows everything until
// the map exactly fills the sheet, so adding entries never needs a layout edit.
// The text file is the source; every output is derived.
//
//   node scripts/build-map.mjs              HTML, SVG, PNG and PDF
//   node scripts/build-map.mjs --html-only  HTML only
//   node scripts/build-map.mjs --strict     fail on names outside the catalogue

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serialiseMap } from './map-svg.mjs'

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

// An entry's status draws its ring: solid by default, dashed for early work,
// dotted for a specification with no runtime of its own.
const STATUSES = {
  early: 'Early or prototype',
  spec: 'Specification',
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
      current = { title, colour: hex, entries: [], standards: [] }
      sections.push(current)
      return
    }
    if (!current) {
      const m = line.match(/^([a-z0-9-]+)\s*:\s*(.*)$/i)
      if (!m) throw new Error(`${where}: expected "key: value" before the first section`)
      meta[m[1].toLowerCase()] = m[2]
      return
    }
    // "+ Name = detail" is a standard shown as a badge under the section's
    // tiles; "+ text" with no "=" is the caption over those badges.
    // "! text" records an honour, such as a prize, for the entry above it.
    if (line.startsWith('!')) {
      const honour = line.slice(1).trim()
      const last = current.entries.at(-1)
      if (!last) throw new Error(`${where}: an honour needs an entry above it`)
      if (!honour) throw new Error(`${where}: empty honour`)
      last.honour = honour
      return
    }
    if (line.startsWith('+')) {
      const [name, detail] = line.slice(1).split('=').map((s) => s.trim())
      if (!name) throw new Error(`${where}: empty standard`)
      if (detail === undefined) current.note = name
      else current.standards.push({ name, detail })
      return
    }
    const [entry, status] = line.split('|').map((s) => s.trim())
    const [name, label] = entry.split('=').map((s) => s.trim())
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`${where}: bad repo name "${name}"`)
    if (status !== undefined && !(status in STATUSES))
      throw new Error(`${where}: unknown status "${status}" (use ${Object.keys(STATUSES).join(' or ')})`)
    current.entries.push({ name, label: label || name, ...(status && { status }) })
  })
  return { meta, sections }
}

function catalogue() {
  const path = join(root, 'forgesworn-repos.json')
  if (!existsSync(path)) return null
  const cat = JSON.parse(readFileSync(path, 'utf8'))
  const listed = new Set()
  for (const c of cat.categories ?? []) for (const r of c.repos ?? c.projects ?? []) listed.add(r.name)
  const excluded = new Set((cat.excludedPublicRepos ?? []).map((r) => r.name))
  return { listed, known: new Set([...listed, ...excluded]) }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function monogram(label) {
  const words = label.replace(/[()]/g, '').split(/[\s._-]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : label.replace(/[^a-z0-9]/gi, '').slice(0, 2)
  return /^\d/.test(letters) ? letters : letters[0].toUpperCase() + (letters[1] ?? '').toLowerCase()
}

// A glyph is a single-colour line icon drawn in currentColor, so it takes the
// section's colour. Anything else, SVG or PNG, is a logo and is shown as drawn.
export function iconFor(name) {
  const png = join(mapDir, 'icons', `${name}.png`)
  if (existsSync(png)) return { kind: 'logo', src: `data:image/png;base64,${readFileSync(png).toString('base64')}` }
  const path = join(mapDir, 'icons', `${name}.svg`)
  if (!existsSync(path)) return null
  const svg = readFileSync(path, 'utf8')
  if (!svg.includes('currentColor'))
    return { kind: 'logo', src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` }
  const inline = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(class|width|height)="[^"]*"/g, '').replace('<svg', '<svg aria-hidden="true"'))
    .trim()
  return { kind: 'glyph', svg: inline }
}

function tile(entry, colour) {
  const icon = iconFor(entry.name)
  const inner = !icon
    ? `<span class="mono">${esc(monogram(entry.label))}</span>`
    : icon.kind === 'glyph'
      ? `<span class="glyph">${icon.svg}</span>`
      : `<img alt="" src="${icon.src}">`
  const cls = (entry.status ? ` is-${entry.status}` : '') + (entry.honour ? ' has-honour' : '')
  const medal = entry.honour
    ? '<span class="medal" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11"/>' +
      '<path d="M12 5.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L12 15.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg></span>'
    : ''
  const honour = entry.honour ? `<small class="honour">${esc(entry.honour)}</small>` : ''
  return `<figure class="tile${cls}">${medal}<div class="icon" style="--c:${colour}">${inner}</div><figcaption>${esc(entry.label)}${honour}</figcaption></figure>`
}

function font(file) {
  return `data:font/woff2;base64,${readFileSync(join(root, 'site', 'fonts', file)).toString('base64')}`
}

// Shared by the HTML pages and the SVGs serialised from them.
const FONT_FACES = `@font-face { font-family: Fraunces; src: url(${font('fraunces-latin.woff2')}) format("woff2"); font-weight: 300 700; }
@font-face { font-family: Inter; src: url(${font('inter-latin.woff2')}) format("woff2"); font-weight: 400 600; }
@font-face { font-family: "JetBrains Mono"; src: url(${font('jetbrains-mono-latin.woff2')}) format("woff2"); font-weight: 400 700; }`

function legend(sections) {
  const used = new Set(sections.flatMap((s) => s.entries.map((e) => e.status)).filter(Boolean))
  const items = [['', 'Working code'], ...Object.entries(STATUSES).filter(([k]) => used.has(k))]
  if (items.length < 2) return ''
  return `<ul class="legend">${items
    .map(([k, text]) => `<li class="tile${k ? ` is-${k}` : ''}"><span class="icon"></span>${esc(text)}</li>`)
    .join('')}</ul>`
}

const THEMES = {
  dark: `--bg:#0a0a0f; --card:#111118; --text:#e8e6e3; --muted:#9896a1; --accent:#e8a838;
    --chip-text:#0a0a0f; --icon-bg:#0d0d14; --fill:12%; --edge:70%; --ink:0%;`,
  light: `--bg:#ffffff; --card:#ffffff; --text:#17161c; --muted:#55535e; --accent:#c27c0e;
    --chip-text:#111016; --icon-bg:#ffffff; --fill:7%; --edge:85%; --ink:38%;`,
}

export function renderHtml({ meta, sections }, { format = 'screen', theme = 'dark', qr = '' } = {}) {
  const a4 = format === 'a4'
  const count = sections.reduce((n, s) => n + s.entries.length, 0)
  const body = sections
    .map((s) => {
      // Badges widen a section as two tiles' worth of room would.
      const n = s.entries.length + Math.ceil(s.standards.length / 2)
      const standards = s.standards.length
        ? `\n  <div class="standards">${s.note ? `<p>${esc(s.note)}</p>` : ''}<ul>${s.standards
            .map((b) => `<li><b>${esc(b.name)}</b> ${esc(b.detail)}</li>`)
            .join('')}</ul></div>`
        : ''
      return `<section style="--c:${s.colour};--n:${n};flex-grow:${n}">
  <h2>${esc(s.title)}</h2>
  <div class="tiles">${s.entries.map((e) => tile(e, s.colour)).join('')}</div>${standards}
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
${FONT_FACES}
@page { size: A4; margin: 0; }
:root { ${THEMES[theme]} }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--text); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* Every size below is in em against .map, whose font-size is one "unit".
   The screen map uses 1px units; the A4 map's units are fitted to the page. */
.map { --u: 1; --tile: 98em; font-size: calc(var(--u) * 1px); display: flex; flex-direction: column; }
.map.screen {
  width: 1400px; padding: 64px 56px 48px;
  background:
    radial-gradient(1200px 600px at 15% -10%, rgba(232,168,56,.14), transparent 60%),
    radial-gradient(900px 700px at 100% 100%, rgba(74,158,255,.10), transparent 60%),
    var(--bg);
}
/* 5mm clears the 4.2mm unprintable edge of a typical laser printer. */
.map.a4 { width: 210mm; height: 297mm; padding: 5mm; overflow: hidden; background: var(--bg); }
header { display: flex; align-items: flex-end; gap: 28em; margin: 0 0 44em 8em; }
header .mark { width: 96em; height: 96em; flex: none; }
header h1 {
  font-family: Fraunces, Georgia, serif; font-variation-settings: "opsz" 144;
  font-weight: 600; font-size: 76em; line-height: .98; letter-spacing: -.02em;
}
header h1 span { display: block; color: var(--accent); }
header .ver { font-family: "JetBrains Mono", monospace; font-size: .24em; color: var(--muted); margin-left: .5em; letter-spacing: 0; }
header .tagline {
  margin-left: auto; max-width: 30em; text-align: right; align-self: center;
  font-family: Inter, sans-serif; font-size: 14em; line-height: 1.45; color: var(--muted);
}
.grid { flex: 1 1 auto; display: flex; flex-wrap: wrap; align-content: space-evenly; gap: 30em 18em; }
section {
  position: relative; flex-basis: calc(min(var(--n), 8) * var(--tile) + 40em);
  display: flex; flex-direction: column; justify-content: center;
  border: 1.5em solid color-mix(in srgb, var(--c) var(--edge), transparent); border-radius: 14em;
  background: color-mix(in srgb, var(--card) calc(100% - var(--fill)), var(--c) var(--fill));
  padding: 30em 18em 16em;
}
h2 {
  position: absolute; top: 0; left: 50%; transform: translate(-50%, -50%); white-space: nowrap;
  background: var(--c); color: var(--chip-text); border-radius: 6em; padding: .3em .9em;
  font-family: "JetBrains Mono", monospace; font-size: 13em; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase;
}
.tiles { display: flex; flex-wrap: wrap; justify-content: space-evenly; gap: 14em 0; }
.tile.has-honour { position: relative; }
.medal { position: absolute; top: -5em; left: calc(50% + 16em); width: 24em; height: 24em; }
.medal svg { width: 100%; height: 100%; display: block; }
.medal circle { fill: #e8a838; stroke: var(--card); stroke-width: 1.5; }
.medal path { fill: #0a0a0f; }
.honour {
  display: block; margin-top: .3em; font-size: .78em; font-weight: 600; line-height: 1.2;
  color: color-mix(in srgb, #e8a838 calc(100% - var(--ink)), black);
}
.standards { margin-top: 16em; display: flex; flex-direction: column; align-items: center; gap: 8em; }
.standards p { font-family: Inter, sans-serif; font-size: 11em; color: var(--muted); letter-spacing: .02em; }
.standards ul { list-style: none; display: flex; flex-wrap: wrap; justify-content: center; gap: 7em; }
.standards li {
  font-family: Inter, sans-serif; font-size: 11.5em; color: var(--text); white-space: nowrap;
  padding: .3em .8em; border-radius: 1em;
  border: .1em solid color-mix(in srgb, var(--c) 70%, transparent);
  background: color-mix(in srgb, var(--c) 10%, transparent);
}
.standards b {
  font-family: "JetBrains Mono", monospace; font-weight: 700; margin-right: .3em;
  color: color-mix(in srgb, var(--c) calc(100% - var(--ink)), black);
}
.tile { width: var(--tile); display: flex; flex-direction: column; align-items: center; gap: 8em; }
.icon {
  --ring: color-mix(in srgb, var(--c, var(--muted)) 55%, transparent);
  width: 60em; height: 60em; border-radius: 50%; display: grid; place-items: center; overflow: hidden;
  background: color-mix(in srgb, var(--icon-bg) 86%, var(--c, var(--muted)) 14%);
  outline: 2em solid var(--ring); outline-offset: 0;
}
.is-early .icon { outline: 2.5em dashed color-mix(in srgb, var(--c, var(--muted)) 90%, transparent); outline-offset: 2em; }
.is-spec .icon { outline: 3em dotted color-mix(in srgb, var(--c, var(--muted)) 90%, transparent); outline-offset: 2em; }
.icon img { width: 40em; height: 40em; }
.glyph { display: grid; place-items: center; color: color-mix(in srgb, var(--c) calc(100% - var(--ink)), black); }
.glyph svg { width: 30em; height: 30em; stroke-width: 1.75; }
.mono {
  width: 100%; height: 100%; display: grid; place-items: center;
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--c) 85%, white 15%), color-mix(in srgb, var(--c) 55%, #0a0a0f));
  color: #0a0a0f; font-family: Fraunces, Georgia, serif; font-variation-settings: "opsz" 48;
  font-weight: 700; font-size: 24em; letter-spacing: -.02em;
}
figcaption {
  font-family: Inter, sans-serif; font-size: 12.5em; font-weight: 500; line-height: 1.25;
  text-align: center; color: var(--text);
}
/* On paper the captions are what people read, so they take a larger share of
   each tile than on screen, the header shrinks, and the rows pack tighter
   so the icons can stay large. */
.a4 { --tile: 92em; }
.a4 header { margin-bottom: 22em; gap: 22em; }
.a4 header .mark { width: 60em; height: 60em; }
.a4 header h1 { font-size: 50em; }
/* Sections stretch to fill their rows, so spare height becomes bigger
   icons (--iz, fitted below) rather than wider gaps. */
.a4 { --iz: 1; }
.a4 .grid { gap: 12em 8em; align-content: stretch; }
.a4 section { padding: 17em 10em 8em; }
.a4 h2 { font-size: 12.5em; }
.a4 .tiles { gap: 8em 0; }
.a4 .standards { margin-top: 12em; gap: 6em; }
.a4 .medal { top: -3.5em; left: calc(50% + 18em * var(--iz)); width: 17em; height: 17em; }
.a4 .standards li { font-size: 11.5em; }
/* Tiles share their section's width, so captions in roomy sections stay on one line. */
.a4 .tile { gap: 4em; flex: 1 0 var(--tile); }
.a4 .icon { width: calc(62em * var(--iz)); height: calc(62em * var(--iz)); outline-width: calc(1.8em * var(--iz)); }
.a4 .icon img { width: calc(48em * var(--iz)); height: calc(48em * var(--iz)); }
.a4 .glyph svg { width: calc(36em * var(--iz)); height: calc(36em * var(--iz)); }
.a4 .mono { font-size: calc(25em * var(--iz)); }
.a4 figcaption { font-size: 14.6em; line-height: 1.2; }
.a4 header .qr { width: 72em; height: 72em; }
.a4 header .site { font-size: 31em; }
/* The address and its QR code sit top right, where a reader looks first. */
header .where { margin-left: auto; text-align: right; align-self: center; }
header .site {
  font-family: Fraunces, Georgia, serif; font-variation-settings: "opsz" 72;
  font-size: 40em; font-weight: 600; color: var(--accent); line-height: 1.1;
}
header .note { font-family: "JetBrains Mono", monospace; font-size: 11em; color: var(--muted); letter-spacing: .02em; margin-top: .6em; }
header .qr { width: 96em; height: 96em; flex: none; align-self: center; }
header .qr svg { width: 100%; height: 100%; display: block; }
header .tagline + .where { margin-left: 0; }
footer { margin-top: 30em; display: flex; justify-content: center; }
.legend { list-style: none; display: flex; gap: 28em; }
.map .legend li {
  width: auto; flex-direction: row; gap: .8em; font-family: Inter, sans-serif; font-size: 12em; color: var(--muted);
}
.map .legend .icon { width: 1.25em; height: 1.25em; outline-width: .15em; background: none; }
.map .legend .is-early .icon, .map .legend .is-spec .icon { outline-offset: .08em; }
.map .legend .is-spec .icon { outline-width: .22em; }
</style>
</head>
<body>
<main class="map ${a4 ? 'a4' : 'screen'}"${a4 ? ' data-fit' : ''}>
<header>
  <svg class="mark" viewBox="0 0 96 96" aria-hidden="true">
    <rect x="2" y="2" width="92" height="92" rx="22" fill="#14141d" stroke="#e8a838" stroke-width="3"/>
    <path transform="translate(16 14) scale(2.67)" d="M4 18h16v2H4v-2zm2-2h12l1-4H5l1 4zm3-6h6l0.5-2h-7l0.5 2zm2-4h2V4h-2v2z" fill="#e8a838"/>
  </svg>
  <h1>${esc(meta.title ?? 'ForgeSworn')}<span>${esc(meta.subtitle ?? 'Ecosystem Map')}<small class="ver">${esc(meta.version ?? '')}</small></span></h1>
  ${meta.tagline ? `<p class="tagline">${esc(meta.tagline)}</p>` : ''}
  <div class="where">${meta.footer ? `<div class="site">${esc(meta.footer)}</div>` : ''}<div class="note">${count} open-source projects · MIT${meta.date ? ` · ${esc(meta.date)}` : ''}</div></div>
  ${qr ? `<div class="qr">${qr}</div>` : ''}
</header>
<div class="grid">
${body}
</div>
${!a4 && legend(sections) ? `<footer>\n  ${legend(sections)}\n</footer>` : ''}
</main>
${a4 ? FIT_SCRIPT : ''}
</body>
</html>
`
}

// Binary-search the unit size that makes the map fill the page without
// spilling over, then grow the icons into any height left over. Runs in the
// page, so printing the HTML directly works too.
const FIT_SCRIPT = `<script>
(() => {
  const map = document.querySelector('.map[data-fit]')
  const fits = () => map.scrollHeight <= map.clientHeight + 0.5 && map.scrollWidth <= map.clientWidth + 0.5
  const search = (prop, lo, hi) => {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      map.style.setProperty(prop, mid)
      if (fits()) lo = mid
      else hi = mid
    }
    map.style.setProperty(prop, lo)
    return lo
  }
  // Icons are capped at 84em across, short of the 92em tile, so rings never touch.
  const grow = u => {
    map.style.setProperty('--u', u)
    map.style.setProperty('--iz', 1)
    return fits() ? search('--iz', 1, 84 / 62) : 0
  }
  const fit = () => {
    map.style.setProperty('--iz', 1)
    const max = search('--u', 0.2, 2)
    // A slightly smaller unit can let sections pack into fewer rows, which
    // frees height for the icons. Give up at most 4% of the text size for it.
    let best = { u: max, icon: 0 }
    for (let i = 0; i <= 16; i++) {
      const u = max * (1 - 0.04 * i / 16)
      const icon = u * grow(u)
      if (icon > best.icon) best = { u, icon }
    }
    grow(best.u)
    document.documentElement.dataset.fitted = best.u.toFixed(3)
  }
  document.fonts.ready.then(fit)
})()
</script>`

async function qrSvg(url) {
  const { renderSVG } = await import(pathToFileURL(join(root, 'site', 'fly', 'vendor', 'qr.js')).href)
  return renderSVG(url, { border: 0 }).replace('<svg', '<svg aria-label="QR code for ' + esc(url) + '"')
}

async function render(outputs) {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    throw new Error('SVG, PNG and PDF need playwright (npm i -D playwright), or pass --html-only')
  }
  const browser = await chromium.launch()
  try {
    for (const { html, svg, png, pdf } of outputs) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 })
      await page.goto(pathToFileURL(html).href)
      await page.evaluate(() => document.fonts.ready)
      if (pdf) {
        await page.emulateMedia({ media: 'print' })
        await page.waitForFunction(() => document.documentElement.dataset.fitted)
        await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true })
      }
      writeFileSync(svg, await page.evaluate(serialiseMap, { fontFaces: FONT_FACES }))
      // The PNG is drawn from the SVG, so the SVG is what every raster shows.
      if (png) {
        await page.goto(pathToFileURL(svg).href)
        await page.evaluate(() => document.fonts.ready)
        await page.locator('svg').first().screenshot({ path: png })
      }
      await page.close()
    }
  } finally {
    await browser.close()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const map = parseMap(readFileSync(join(mapDir, 'ecosystem.txt'), 'utf8'))

  const cat = catalogue()
  const seen = new Set()
  const problems = []
  for (const s of map.sections)
    for (const e of s.entries) {
      if (seen.has(e.name)) problems.push(`${e.name} appears twice`)
      seen.add(e.name)
      if (cat && !cat.known.has(e.name)) problems.push(`${e.name} is not in forgesworn-repos.json`)
    }
  for (const p of problems) console.warn(`warning: ${p}`)
  if (cat) {
    const missing = [...cat.listed].filter((n) => !seen.has(n))
    if (missing.length) console.log(`not on the map (${missing.length}): ${missing.join(', ')}`)
  }
  if (problems.length && args.has('--strict')) process.exit(1)

  const count = map.sections.reduce((n, s) => n + s.entries.length, 0)
  const screenHtml = join(mapDir, 'ecosystem-map.html')
  const a4Html = join(mapDir, 'ecosystem-map-a4.html')
  writeFileSync(screenHtml, renderHtml(map))
  const qr = map.meta.qr ? await qrSvg(map.meta.qr) : ''
  writeFileSync(a4Html, renderHtml(map, { format: 'a4', theme: 'light', qr }))
  console.log(`wrote map/ecosystem-map.html and map/ecosystem-map-a4.html (${map.sections.length} sections, ${count} entries)`)

  if (!args.has('--html-only')) {
    await render([
      { html: screenHtml, svg: join(mapDir, 'ecosystem-map.svg'), png: join(mapDir, 'ecosystem-map.png') },
      { html: a4Html, svg: join(mapDir, 'ecosystem-map-a4.svg'), pdf: join(mapDir, 'ecosystem-map-a4.pdf') },
    ])
    console.log('wrote map/ecosystem-map.svg, map/ecosystem-map.png, map/ecosystem-map-a4.svg and map/ecosystem-map-a4.pdf')
  }
}
