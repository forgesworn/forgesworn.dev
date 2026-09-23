import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMap, renderHtml } from '../scripts/build-map.mjs'

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
