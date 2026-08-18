import { chromium } from 'playwright';
import { safeShot, harvestText, scan } from '../shotguard.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Output goes beside this script unless told otherwise. Never hardcode an
// absolute path: it leaks the operator's home directory into a public repo.
const OUT = process.env.SHOT_OUT || join(process.cwd(), 'captures-out', 'sapwood');
mkdirSync(OUT, { recursive: true });

// Deliberately, visibly synthetic. Anyone reading the screenshot can tell these
// are demo values, and they are allowlisted below so the guard lets them past
// while still failing closed on anything it was not told about.
const DEMO_PUB   = 'deadbeef'.repeat(8);          // 64 hex, obviously fake
const DEMO_OP    = 'feedface'.repeat(8);
// Each slot needs its own key: the list is keyed by npub, and duplicates
// collapse the render.
const SLOT_KEYS  = ['cafebabe', 'badc0ffe', 'facefeed'].map(w => w.repeat(8));
const DEMO_RELAY = 'wss://relay.damus.io';
const ALLOW = [DEMO_PUB, DEMO_OP, ...SLOT_KEYS];

const MASTER = {
  slot: 0, label: 'daily', mode: -1, npub: DEMO_PUB, addressed: true,
};

// Real ConnectSlot shape (src/lib/types.ts). `secret` is redacted to '' in list
// responses on the device too, so there is nothing sensitive to show here.
const SLOTS = [
  { slot_index: 0, label: 'Bark (browser)',  secret: '', current_pubkey: SLOT_KEYS[0],
    allowed_methods: ['sign_event', 'nip44_encrypt', 'nip44_decrypt', 'get_public_key'],
    allowed_kinds: [1, 7, 6, 30023], auto_approve: true,  signing_approved: true, strict_permissions: true },
  { slot_index: 1, label: 'Cambium (phone)', secret: '', current_pubkey: SLOT_KEYS[1],
    allowed_methods: ['sign_event', 'get_public_key'],
    allowed_kinds: [1, 7], auto_approve: true,  signing_approved: true, strict_permissions: true },
  { slot_index: 2, label: 'Bray (terminal)', secret: '', current_pubkey: SLOT_KEYS[2],
    allowed_methods: ['sign_event'],
    allowed_kinds: [1], auto_approve: false, signing_approved: true, strict_permissions: true },
];

const b = await chromium.launch({ channel: 'chrome' });
const page = await b.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 140)));

await page.addInitScript(() => { window.__sapwoodE2E = true; });
await page.goto('http://localhost:8820/#/', { waitUntil: 'networkidle' });

await page.evaluate(({ m, s, relay, op }) => {
  window.__sapwoodConnect({
    masters: [m], slots: s, mode: 'relay', operatorPub: op, relays: [relay],
    relayStatus: { master_count: 1, slots: s.length, mode: 'wifi-standalone', relay, capabilities: [] },
  });
}, { m: MASTER, s: SLOTS, relay: DEMO_RELAY, op: DEMO_OP });

await page.waitForTimeout(1200);

const shots = [];
async function grab(name) {
  try {
    const r = await safeShot(page, `${OUT}/${name}.png`, { allow: ALLOW });
    shots.push(`  captured ${name}.png (scanned ${r.scannedChars} chars)`);
  } catch (e) {
    shots.push(`  ${String(e.message).split('\n').join('\n  ')}`);
  }
}

await grab('01-home');

// Advanced cockpit
const adv = page.getByRole('button', { name: 'Advanced ⚙', exact: true });
if (await adv.count()) { await adv.click(); await page.waitForTimeout(800); await grab('02-advanced'); }

console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none');
console.log(shots.join('\n'));
console.log('\n--- visible text on the connected home ---');
console.log((await page.evaluate(() => document.body.innerText)).slice(0, 900));
await b.close();
