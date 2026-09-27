import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMap, renderHtml, iconFor } from '../scripts/build-map.mjs'

test('parses header, sections, labels and colours', () => {
  const map = parseMap(`# comment
title: ForgeSworn
version: v1

## Wallets & NWC | gold
nwc-kit = NWC Kit
farrier-kit

## Custom | #123456
anvil`)
  assert.deepEqual(map.meta, { title: 'ForgeSworn', version: 'v1' })
  assert.equal(map.sections.length, 2)
  assert.equal(map.sections[0].colour, '#e8a838')
  assert.deepEqual(map.sections[0].entries, [
    { name: 'nwc-kit', label: 'NWC Kit' },
    { name: 'farrier-kit', label: 'farrier-kit' },
  ])
  assert.equal(map.sections[1].colour, '#123456')
})

test('rejects an unknown colour and a malformed entry', () => {
  assert.throws(() => parseMap('## X | mauve\na'), /unknown colour/)
  assert.throws(() => parseMap('## X\n<b>bad</b>'), /bad repo name/)
})

test('escapes labels in the rendered page', () => {
  const html = renderHtml(parseMap('## A & B\nx = <script>'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(!html.includes('<script>'))
})

test('parses an optional status and rejects an unknown one', () => {
  const map = parseMap('## X\nheartwood-ledger = Heartwood Ledger | early\nnip-drafts | spec\nanvil')
  assert.deepEqual(map.sections[0].entries, [
    { name: 'heartwood-ledger', label: 'Heartwood Ledger', status: 'early' },
    { name: 'nip-drafts', label: 'nip-drafts', status: 'spec' },
    { name: 'anvil', label: 'anvil' },
  ])
  assert.throws(() => parseMap('## X\na | beta'), /unknown status "beta"/)
})

test('marks status on the tile and only shows the legend when a status is used', () => {
  const plain = renderHtml(parseMap('## X\nanvil'))
  assert.ok(!plain.includes('class="legend"'))
  const marked = renderHtml(parseMap('## X\nanvil\nnip-drafts | spec'))
  assert.ok(marked.includes('class="tile is-spec"'))
  assert.ok(marked.includes('class="legend"'))
  assert.ok(marked.includes('Specification'))
})

test('the A4 page is fixed to the sheet and carries the fitting script', () => {
  const html = renderHtml(parseMap('## X\nanvil'), { format: 'a4', theme: 'light' })
  assert.ok(html.includes('class="map a4" data-fit'))
  assert.ok(html.includes('@page { size: A4'))
  assert.ok(html.includes('document.fonts.ready.then(fit)'))
  assert.ok(!renderHtml(parseMap('## X\nanvil')).includes('data-fit'))
})

test('inlines a glyph without losing the sizes of its inner shapes', () => {
  // notelocker is still a Lucide stand-in (see map/icons/LICENCE-lucide.txt);
  // its <rect> is what proves inner shapes keep their own width when inlined.
  const icon = iconFor('notelocker')
  assert.equal(icon.kind, 'glyph')
  assert.ok(!/<svg[^>]*\swidth=/.test(icon.svg), 'root svg keeps no fixed width')
  assert.ok(/<rect[^>]*\swidth=/.test(icon.svg), 'inner rect keeps its width')
  assert.equal(iconFor('nwc-kit').kind, 'logo')
  assert.equal(iconFor('no-such-repo'), null)
})

test('parses standards badges and their caption, and escapes them', () => {
  const map = parseMap('## Specs\nnip-drafts | spec\n+ Drafts we author\n+ NIP-VA = attestations, kind 31000\n+ <b> = x & y')
  assert.equal(map.sections[0].note, 'Drafts we author')
  assert.deepEqual(map.sections[0].standards, [
    { name: 'NIP-VA', detail: 'attestations, kind 31000' },
    { name: '<b>', detail: 'x & y' },
  ])
  const html = renderHtml(map)
  assert.ok(html.includes('<li><b>NIP-VA</b> attestations, kind 31000</li>'))
  assert.ok(html.includes('<li><b>&lt;b&gt;</b> x &amp; y</li>'))
  assert.ok(html.includes('<p>Drafts we author</p>'))
  assert.throws(() => parseMap('## X\n+ = nothing'), /empty standard/)
})
