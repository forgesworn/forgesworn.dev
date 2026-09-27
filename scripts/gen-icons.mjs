#!/usr/bin/env node
// Generates map glyphs for entries with no logo of their own, using GPT-Image
// Sunburst, within a spend cap. Only entries with a prompt below and no
// existing map/icons/<name>.svg or .png are drawn.
//
//   node scripts/gen-icons.mjs                 draw everything queued
//   node scripts/gen-icons.mjs --only kenspeckle   names starting with this (comma-separate several)
//   node scripts/gen-icons.mjs --force          regenerate, keeping the old original
//   node scripts/gen-icons.mjs --redo           re-trace every existing original, no API call
//
// Every call is logged to map/icons/icon-ledger.json with its token usage and
// cost. The run stops before any call that could take total spend past
// CAP_USD. Refusals and errors are logged and never retried automatically.
//
// Each generated original is a black pictogram on white (map/icons/originals/
// <name>.png), then vectorised into a currentColor glyph at map/icons/<name>.svg
// so the renderer tints it with the section colour. Re-run vectorise() alone
// with --only to redo just the trace step for one icon.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconsDir = join(root, 'map', 'icons')
const originalsDir = join(iconsDir, 'originals')
const glyphsDir = join(iconsDir, 'glyphs')
const ledgerPath = join(iconsDir, 'icon-ledger.json')

const MODEL = 'gpt-image-2.5-sunburst-2026-09-08'
const CAP_USD = 15
// Per 1M tokens, from OpenAI's pricing page (2026-09-27).
const PRICE = { textIn: 5, imageIn: 8, out: 30 }
// Worst-case assumed per call before the real usage is known, for the cap check.
const MAX_CALL_USD = 0.5
const CONCURRENCY = 4

const KEY = process.env.OPENAI_API_KEY
if (!KEY) {
  console.error('OPENAI_API_KEY is not set.')
  process.exit(1)
}

// The shared style suffix. The model draws in three flat tones, which the
// vectoriser separates and recolours (see LAYERS below).
const STYLE =
  'Flat vector emblem drawn with exactly three flat colours on a plain pure white ' +
  'background: pure black (#000000) for the main shape, pure red (#FF0000) for one or ' +
  'two small accent details, and pure blue (#0000FF) for a secondary part. No other ' +
  'colours, no gradients, no shading, no texture, no outlines, no text or letters. One ' +
  'clear subject, centred, filling most of the frame with a generous even margin. ' +
  'Clean, confident geometric forms like a crafted enamel badge: chunky, ' +
  'high-contrast and legible at a tiny size.'

// One bespoke pictogram per project, from its README and catalogue description.
// Only entries with no logo of their own are listed: everything Lucide was
// covering, plus the new entries that had no icon at all.
const PROMPTS = {
  '402-announce':
    'A pictogram of a megaphone pointing right with a bold lightning bolt on its side and three short sound lines coming from its mouth. ' + STYLE,
  '402-indexer':
    'A pictogram of a magnifying glass over a short stack of three ruled index ' +
    'cards, one card corner turned up. ' + STYLE,
  '402-mcp':
    'A pictogram of a simple rounded robot head seen from the front, two round eyes and a bold lightning bolt in the middle of its forehead, no body and no cables. ' + STYLE,
  anvil:
    'A pictogram of a classic blacksmith\'s anvil, seen from the side, solid ' +
    'and chunky with a single horn. ' + STYLE,
  'aperture-announce':
    'A pictogram of a small aperture-blade iris, half closed, with a single ' +
    'curved broadcast wave arcing away from one edge. ' + STYLE,
  'aperture-phoenixd':
    'A pictogram of a camera aperture blade iris, fully closed to a small ' +
    'point, with a single small phoenix-feather flame rising from its centre. ' + STYLE,
  bark:
    'A pictogram of a rounded jigsaw browser-extension puzzle piece with a ' +
    'small key shape cut out of its middle. ' + STYLE,
  bray:
    'A pictogram of a friendly donkey head in profile with both ears raised, ' +
    'simplified to bold rounded shapes. ' + STYLE,
  'capacitor-mesh-ble':
    'A pictogram of two identical rounded rectangle phone shapes side by side ' +
    'with a visible gap between them, and three small concentric arcs like a ' +
    'Bluetooth signal bridging the gap between their edges. ' + STYLE,
  context:
    'A pictogram of a small node-and-edge graph, three connected circles ' +
    'joined by lines, with the centre circle wearing a wax-seal ring like a ' +
    'signature. ' + STYLE,
  'covey-kit':
    'A pictogram of a small flock of three birds flying together in a tight ' +
    'V formation, wings simplified to bold triangular shapes. ' + STYLE,
  dominion:
    'A pictogram of a stylised castle keep tower with a single crenellated ' +
    'battlement and a small padlock set into its gate. ' + STYLE,
  'epoch-seal':
    'A pictogram of a round wax seal stamped with an hourglass shape at its ' +
    'centre. ' + STYLE,
  'flock-kit':
    'A pictogram of a round radar screen: a thick circle, a single solid sweep wedge from the centre, and two small dots inside the circle. ' + STYLE,
  'forgesworn-demos':
    'A pictogram of a play triangle inside a hexagonal nut or gear outline, ' +
    'like a demo reel meeting a mechanical part. ' + STYLE,
  'geohash-kit':
    'A pictogram of a location pin shape filled with a small 3x3 grid of ' +
    'squares, like a map reference cut into the pin. ' + STYLE,
  'jurisdiction-kit':
    'A pictogram of a plain circle globe with two bold curved meridian lines ' +
    'crossing it and one horizontal equator line, a small flat pediment roof ' +
    'on three columns (a courthouse front) sitting on top of the circle like a ' +
    'hat. ' + STYLE,
  kenspeckle:
    'A pictogram for verified relationships at three social distances: three ' +
    'concentric rings around a small solid dot at the centre, like ripples of ' +
    'recognition spreading outward, the outer ring drawn slightly open like a ' +
    'handshake clasp. ' + STYLE,
  'keystore-kit':
    'A pictogram of a single old-fashioned door key, its round bow shaped ' +
    'like a small pentagon shield, laid horizontally in front of and ' +
    'overlapping a plain thick-walled circle like a vault door. ' + STYLE,
  moneyer:
    'A pictogram of one thick round coin seen face-on with a bold lightning bolt embossed in its centre, and a small blacksmith\'s hammer resting diagonally across its upper right edge. ' + STYLE,
  'mesh-kit':
    'A pictogram of a triangular mesh of dots joined by straight lines, like a ' +
    'small geodesic net, six nodes and connecting edges. ' + STYLE,
  'nip-drafts':
    'A pictogram of a single sheet of paper with a folded top corner and three ' +
    'short ruled lines, a small pencil laid diagonally across it. ' + STYLE,
  'nostr-anon-vote':
    'A pictogram of a ballot box with a single slot, a small ring shape ' +
    'dropping into the slot in place of a paper ballot. ' + STYLE,
  'nostr-attestations':
    'A pictogram of a round official stamp or rosette seal with a bold ' +
    'checkmark at its centre. ' + STYLE,
  'nostr-contact-card':
    'A pictogram of a small rectangular contact card with a corner-mounted QR ' +
    'square and a single ruled name line beneath it. ' + STYLE,
  'nostr-deaddrop':
    'A pictogram of a plain envelope with no visible seams, a single small ' +
    'question mark replacing the usual sender mark on its flap. ' + STYLE,
  'nostr-succession':
    'A pictogram of a key handing off to a second identical key along a short ' +
    'curved arrow, like a baton pass. ' + STYLE,
  'nostr-veil':
    'A pictogram of a simple hooded cloak or veil shape draped over a small ' +
    'ring, hiding most of it from view. ' + STYLE,
  notecase:
    'A pictogram of a slim wallet case, open a little, with a folded bearer ' +
    'note tucked halfway inside it. ' + STYLE,
  'nsec-tree':
    'A pictogram of a bare tree trunk branching into three smaller branches, ' +
    'each branch ending in a small key-tooth shape instead of a leaf. ' + STYLE,
  'nsec-tree-cli':
    'A pictogram of a bare tree trunk branching into three smaller branches ' +
    'ending in key-tooth shapes, growing out of a small terminal-prompt ' +
    'rectangle with a blinking cursor bar. ' + STYLE,
  'nwc-lnd-bridge':
    'A pictogram of a simple arched bridge with a small lightning bolt ' +
    'crossing beneath its span. ' + STYLE,
  'payment-methods':
    'A pictogram of a single coin with a lightning bolt embossed on its face, ' +
    'resting on a short ruled specification line. ' + STYLE,
  'private-equality':
    'A pictogram of two overlapping circles like a Venn diagram, an equals ' +
    'sign filling the small lens where they overlap. ' + STYLE,
  'range-proof':
    'A pictogram of a short horizontal bar or ruler with a single bold tick ' +
    'mark sitting between two bracket ends, proving a point falls in range. ' + STYLE,
  'relayswarm':
    'A pictogram of a small television or play-screen shape with three curved ' +
    'broadcast waves fanning out from one corner like a swarm signal. ' + STYLE,
  'rendezvous-kit':
    'A pictogram of three location pins arranged around a shared point, thin ' +
    'lines converging from each pin to one small circle in the middle. ' + STYLE,
  'rendezvous-mcp':
    'A pictogram of three location pins converging on a small robot-head ' +
    'shape at the centre where their lines meet. ' + STYLE,
  'ring-sig':
    'A pictogram of a ring of small overlapping circles joined edge to edge in ' +
    'a closed loop, like a chain of linked rings forming a wreath. ' + STYLE,
  'roost-kit':
    'A pictogram of a simple bird roosting on a horizontal perch bar, wings ' +
    'folded, drawn as bold rounded shapes. ' + STYLE,
  sapwood:
    'A pictogram of a round tree-trunk slice seen end-on: a solid disc with three thin concentric growth-ring gaps, the outermost ring band wider than the others, and one small leaf sprouting from its top edge. ' + STYLE,
  'shamir-core':
    'A pictogram of a single circle split into three equal pie-slice pieces, ' +
    'each piece drawn slightly pulled apart from the others. ' + STYLE,
  'shamir-words':
    'A pictogram of three separated pie-slice pieces of a circle, each piece ' +
    'replaced by a short row of ruled lines like printed words on a card. ' + STYLE,
  'shelter-kit':
    'A pictogram of a simple gabled shelter roof shape over a stack of three ' +
    'horizontal storage bars. ' + STYLE,
  signet:
    'A pictogram of a round signet-ring seal viewed face on, a simple emblem ' +
    'in relief at its centre and a plain band below. ' + STYLE,
  'signet-contacts':
    'A pictogram of a small address-book card with a round wax-seal signet ' +
    'stamped in its corner, the seal showing a simple ring motif. ' + STYLE,
  'signet-credentials':
    'A pictogram of a small certificate or ribboned card with a round seal ' +
    'medallion hanging from its lower edge on a short ribbon. ' + STYLE,
  'signet-login':
    'A pictogram of a rounded doorway arch with a signet-ring seal set where ' +
    'a keyhole would normally be. ' + STYLE,
  'signet-verify':
    'A pictogram of a web browser window drawn as a rounded rectangle with a thin top bar, holding a bold shield with a checkmark in its centre. ' + STYLE,
  'spoken-token':
    'A pictogram of a simple speech bubble with a short row of dashes inside ' +
    'it that rotate like a combination-lock dial, suggesting rotating spoken ' +
    'words. ' + STYLE,
  'tessera-kit':
    'A pictogram of a three by three grid of small square mosaic tiles with narrow even gaps between them, the centre tile replaced by a round keyhole shape. ' + STYLE,
  'toll-booth':
    'A pictogram of a toll booth: a small kiosk with a pitched roof and a window, beside a raised striped barrier arm, a bold lightning bolt on the front of the kiosk. ' + STYLE,
  'toll-booth-dvm':
    'A pictogram of a simple vending machine: a tall rectangular cabinet with a window of four small square slots, a coin slot on the right and a bold lightning bolt on its lower panel. ' + STYLE,
  'toll-booth-mcp':
    'A pictogram of a simple bar chart of three rising bars inside a rounded square frame, with a small lightning bolt in the top right corner. ' + STYLE,
  'trott-conformance':
    'A pictogram of a rectangular clipboard with a small clip at the top and ' +
    'three short horizontal ruled lines below it, a single bold oversized ' +
    'checkmark stamped diagonally across the whole clipboard. ' + STYLE,
}

// Every drawn icon is set on a tile in the style of My Signet's app icon: a
// deep rounded square in its map section's colour, a thin gold ring and the
// glyph in ivory. The section colours match build-map.mjs; the tile is a
// quarter of that colour over near-black.
const SECTION_COLOURS = {
  gold: '#e8a838', amber: '#f59e0b', blue: '#4a9eff', green: '#34d399',
  teal: '#2dd4bf', red: '#f87171', rose: '#fb7185', purple: '#a78bfa',
}
const RING = '#C9A962'
const IVORY = '#FAF7ED'
const BASE = [6, 8, 15]

function deepen(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return '#' + rgb.map((c, i) => Math.round(c * 0.25 + BASE[i] * 0.75).toString(16).padStart(2, '0')).join('')
}

// Section colour for each entry in map/ecosystem.txt; entries not on the map
// (language ports copy their parent's icon anyway) fall back to blue.
const sectionOf = new Map()
{
  let colour = 'gold'
  for (const line of readFileSync(join(root, 'map', 'ecosystem.txt'), 'utf8').split('\n')) {
    if (line.startsWith('## ')) colour = (line.split('|')[1] ?? 'gold').trim()
    else if (/^[a-z0-9][a-z0-9.-]*\s*=/.test(line)) sectionOf.set(line.split('=')[0].trim(), colour)
  }
}
const brightColour = (name) => {
  const c = sectionOf.get(name) ?? 'blue'
  return SECTION_COLOURS[c] ?? (c.startsWith('#') ? c : SECTION_COLOURS.blue)
}
const tileColour = (name) => {
  const c = sectionOf.get(name) ?? 'blue'
  return deepen(SECTION_COLOURS[c] ?? (c.startsWith('#') ? c : SECTION_COLOURS.blue))
}

const args = process.argv.slice(2)
const force = args.includes('--force')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null
const picked = (name) => !only || only.some((prefix) => name.startsWith(prefix))

const ledger = existsSync(ledgerPath)
  ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
  : { model: MODEL, capUsd: CAP_USD, spentUsd: 0, calls: [] }
mkdirSync(originalsDir, { recursive: true })
const save = () => writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')

function costOf(usage) {
  const details = usage?.input_tokens_details ?? {}
  const imageIn = details.image_tokens ?? 0
  const textIn = details.text_tokens ?? Math.max(0, (usage?.input_tokens ?? 0) - imageIn)
  return (textIn * PRICE.textIn + imageIn * PRICE.imageIn + (usage?.output_tokens ?? 0) * PRICE.out) / 1e6
}

let inFlight = 0
let stopped = false
const queue = Object.entries(PROMPTS).filter(([name]) => picked(name))

async function generate(name, prompt) {
  const original = join(originalsDir, `${name}.png`)
  if (existsSync(original) && !force) return true
  if (existsSync(original)) {
    // --force never overwrites a paid original: it is kept alongside with a timestamp.
    const kept = join(originalsDir, `${name}.${Date.now()}.png`)
    writeFileSync(kept, readFileSync(original))
  }
  if (ledger.spentUsd + inFlight * MAX_CALL_USD > CAP_USD) {
    console.log(`Stopping before ${name}: $${ledger.spentUsd.toFixed(2)} spent, cap $${CAP_USD}.`)
    stopped = true
    return false
  }
  const body = { model: MODEL, prompt, size: '1024x1024', quality: 'high', n: 1, output_format: 'png' }
  const started = new Date().toISOString()
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  const usd = costOf(json.usage)
  ledger.spentUsd += usd
  ledger.calls.push({ at: started, name, prompt, ok: res.ok, status: res.status, usage: json.usage ?? null, usd: +usd.toFixed(4), error: json.error?.message ?? null })
  save()
  if (!res.ok || !json.data?.[0]?.b64_json) {
    console.log(`${name}: FAILED ${res.status} ${json.error?.message ?? ''}`)
    return false
  }
  writeFileSync(original, Buffer.from(json.data[0].b64_json, 'base64'))
  console.log(`${name}: ok, $${usd.toFixed(3)} (total $${ledger.spentUsd.toFixed(2)})`)
  return true
}

// Threshold, trace with potrace and normalise the bounding box so every glyph
// fills the same share of a square viewBox, centred, ready for currentColor.
// potrace's path data is mostly relative (lowercase l/c/m) with a single
// absolute M anchor, so a number in the middle of the path is a delta, not a
// point: it cannot be transformed on its own. This walks the path, tracking
// the real running position, and returns every point (line ends and curve
// control points) already in potrace's own translate/scale space.
function walkPath(d, tx, ty, sx, sy) {
  const tokens = d.match(/[MmLlCcZz]|-?[\d.]+/g) ?? []
  const at = (px, py) => [tx + px * sx, ty + py * sy]
  const subpaths = []
  let i = 0
  let cmd = null
  let x = 0, y = 0, startX = 0, startY = 0
  let current = null
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++]
    if (cmd === 'M' || cmd === 'm') {
      const [nx, ny] = [Number(tokens[i]), Number(tokens[i + 1])]
      i += 2
      x = cmd === 'M' ? nx : x + nx
      y = cmd === 'M' ? ny : y + ny
      startX = x; startY = y
      current = { start: at(x, y), segs: [] }
      subpaths.push(current)
      cmd = cmd === 'M' ? 'L' : 'l' // an implicit repeat of a moveto is a lineto
    } else if (cmd === 'L' || cmd === 'l') {
      const [nx, ny] = [Number(tokens[i]), Number(tokens[i + 1])]
      i += 2
      x = cmd === 'L' ? nx : x + nx
      y = cmd === 'L' ? ny : y + ny
      current.segs.push({ type: 'L', pt: at(x, y) })
    } else if (cmd === 'C' || cmd === 'c') {
      const n = tokens.slice(i, i + 6).map(Number)
      i += 6
      const abs = cmd === 'C' ? [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]]]
        : [[x + n[0], y + n[1]], [x + n[2], y + n[3]], [x + n[4], y + n[5]]]
      current.segs.push({ type: 'C', pts: abs.map(([px, py]) => at(px, py)) })
      ;[x, y] = abs[2]
    } else if (cmd === 'Z' || cmd === 'z') {
      current.segs.push({ type: 'Z' })
      x = startX; y = startY
    } else {
      throw new Error(`unhandled path command "${cmd}"`)
    }
  }
  return subpaths
}

// The model draws each emblem in three flat tones. Each tone is traced as its
// own layer and recoloured on the tile: black becomes ivory, red becomes gold
// and blue becomes the bright form of the section's colour. A single-tone
// original simply has no gold or colour layer.
const LAYERS = [
  { tone: '#000000', label: 'ivory', fill: () => IVORY },
  { tone: '#0000ff', label: 'colour', fill: (name) => brightColour(name) },
  { tone: '#ff0000', label: 'gold', fill: () => RING },
]

function readTrace(file) {
  const traced = readFileSync(file, 'utf8')
  // potrace writes each separate shape as its own <path>; every one starts
  // with an absolute M, so their data joins into a single path.
  const paths = [...traced.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1])
  if (!paths.length) return []
  // potrace draws in a y-down coordinate space translated/scaled inside a <g>.
  const t = traced.match(/<g transform="translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+),([-\d.]+)\)"/)
  if (!t) throw new Error(`${file}: unexpected potrace transform`)
  const [tx, ty, sx, sy] = t.slice(1).map(Number)
  return walkPath(paths.join(' '), tx, ty, sx, sy)
}

function vectorise(name) {
  const original = join(originalsDir, `${name}.png`)
  const tmp = mkdtempSync(join(tmpdir(), 'gen-icons-'))
  let layers
  try {
    const palette = join(tmp, 'palette.png')
    const quantised = join(tmp, 'quantised.png')
    execFileSync('magick', ['-size', '1x1', 'xc:#ffffff', ...LAYERS.map((l) => `xc:${l.tone}`), '+append', palette])
    // Snap every pixel to white or one of the three tones, then trace each tone.
    execFileSync('magick', [original, '-background', 'white', '-flatten', '-resize', '512x512', '-dither', 'None', '-remap', palette, quantised])
    layers = LAYERS.map((layer) => {
      const mask = join(tmp, `${layer.label}.pbm`)
      const trace = join(originalsDir, `${name}.${layer.label}.trace.svg`)
      execFileSync('magick', [quantised, '-fill', 'white', '+opaque', layer.tone, '-fill', 'black', '-opaque', layer.tone, mask])
      execFileSync('potrace', [mask, '--svg', '--turdsize', '20', '--opttolerance', '0.4', '-o', trace])
      const subpaths = readTrace(trace)
      if (!subpaths.length) rmSync(trace)
      return { ...layer, subpaths }
    }).filter((l) => l.subpaths.length)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (!layers.length) throw new Error(`${name}: nothing to trace`)
  // The single-tone trace this replaces.
  for (const old of [`${name}.trace.svg`, `${name}.pbm`]) rmSync(join(originalsDir, old), { force: true })

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const see = ([px, py]) => {
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
  }
  for (const layer of layers) {
    for (const sp of layer.subpaths) {
      see(sp.start)
      for (const seg of sp.segs) {
        if (seg.type === 'L') see(seg.pt)
        else if (seg.type === 'C') seg.pts.forEach(see)
      }
    }
  }
  const boxW = maxX - minX
  const boxH = maxY - minY
  const cx = minX + boxW / 2
  const cy = minY + boxH / 2
  // Normalise so the artwork's longest side fills 88% of a 100x100 viewBox,
  // centred, giving every icon the same visual weight regardless of its shape.
  const norm = 88 / Math.max(boxW, boxH)
  const map = ([px, py]) => [((px - cx) * norm + 50).toFixed(2), ((py - cy) * norm + 50).toFixed(2)]
  const pathData = (subpaths) => subpaths
    .map((sp) => {
      const parts = [`M${map(sp.start).join(',')}`]
      for (const seg of sp.segs) {
        if (seg.type === 'L') parts.push(`L${map(seg.pt).join(',')}`)
        else if (seg.type === 'C') parts.push(`C${seg.pts.map((p) => map(p).join(',')).join(' ')}`)
        else parts.push('Z')
      }
      return parts.join(' ')
    })
    .join(' ')
  const ds = layers.map((l) => ({ fill: l.fill(name), d: pathData(l.subpaths) }))

  const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
${ds.map(({ d }) => `  <path fill="currentColor" d="${d}"/>`).join('\n')}
</svg>
`
  mkdirSync(glyphsDir, { recursive: true })
  writeFileSync(join(glyphsDir, `${name}.svg`), glyph)
  // A hairline stroke in each layer's own colour closes the seams potrace leaves
  // between neighbouring tones.
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="${tileColour(name)}"/>
  <circle cx="50" cy="50" r="38.4" fill="none" stroke="${RING}" stroke-width="1.4"/>
  <g transform="translate(20 20) scale(0.6)" stroke-width="0.8" stroke-linejoin="round">
${ds.map(({ fill, d }) => `    <path fill="${fill}" stroke="${fill}" d="${d}"/>`).join('\n')}
  </g>
</svg>
`
  writeFileSync(join(iconsDir, `${name}.svg`), tile)
  console.log(`${name}: traced ${layers.map((l) => l.label).join(' + ')} -> map/icons/${name}.svg`)
}

if (args.includes('--redo')) {
  // Rebuild every glyph and tile from its original, with no API call.
  for (const name of Object.keys(PROMPTS)) {
    if (!picked(name) || !existsSync(join(originalsDir, `${name}.png`))) continue
    vectorise(name)
  }
} else {
  async function worker() {
    while (queue.length && !stopped) {
      const [name, prompt] = queue.shift()
      inFlight++
      try {
        const ok = await generate(name, prompt)
        if (ok) vectorise(name)
      } finally {
        inFlight--
      }
    }
  }
  await Promise.all([...Array(CONCURRENCY)].map(worker))
}

// Language ports are left off the map but keep an exact copy of their parent's
// icon, refreshed on every run so a redrawn parent never leaves a port behind.
const PORTS = {
  'kithmoot-android': 'kithmoot',
  'toll-booth-rs': 'toll-booth',
  'nsec-tree-py': 'nsec-tree',
  'signet-protocol-rs': 'signet',
  'gopherkind-protocol-py': 'gopherkind',
  'relayswarm-kit': 'relayswarm',
}
for (const [port, parent] of Object.entries(PORTS)) {
  for (const ext of ['png', 'svg']) {
    const src = join(iconsDir, `${parent}.${ext}`)
    if (existsSync(src)) copyFileSync(src, join(iconsDir, `${port}.${ext}`))
  }
}
