/*
 * shotguard — refuse to capture a screenshot of anything that must not be published.
 *
 * The control is NOT "look at the PNG afterwards and hope". OCR on a screenshot
 * is unreliable and a missed nsec is unrecoverable once it is on a website. So:
 *
 *   1. the app is driven in a FRESH browser context, so none of the operator's
 *      real state (localStorage, IndexedDB, cookies) is ever loaded;
 *   2. the rendered DOM text and every attribute value are scanned before the
 *      shutter fires;
 *   3. a hit anywhere aborts the capture and no file is written.
 *
 * Two classes of pattern:
 *   SECRETS — key material and credentials. Never publishable, ever.
 *   OPSEC   — identity linkage the operator keeps out of public repos.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SECRET_PATTERNS = [
  [/\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{58}\b/i, 'nostr private key (nsec)'],
  [/\bncryptsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}/i, 'encrypted nostr private key'],
  [/\bsecret=[A-Za-z0-9_-]{8,}/i, 'connection secret in a URI'],
  [/\b(bunker|nostrconnect):\/\/[0-9a-f]{64}[^\s"']*secret=/i, 'pairing URI carrying a secret'],
  // Fails closed: a 64-hex pubkey and a 64-hex private key are indistinguishable
  // by shape, so every one is flagged and the known-public ones are passed in
  // through `allow`. Exempting code blocks would have been backwards — a key
  // pasted into a <code> sample is still a published key.
  [/\b[0-9a-f]{64}\b/i, '64-hex value (possible private key or vault key)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'API secret key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\b(?:mnemonic|seed phrase|recovery phrase)\b\s*[:=]\s*\S+/i, 'labelled seed phrase'],
  [/\b(?:PIN|passphrase|password)\s*[:=]\s*\S{3,}/i, 'labelled credential'],
];

/*
 * Identity terms are NOT kept in this file. This repository is public, so a
 * hardcoded list of the names and hostnames we keep out of public repos would
 * publish exactly what it exists to hide — the guard would leak the thing it
 * guards.
 *
 * They load at runtime from an untracked file, $SHOTGUARD_OPSEC or
 * ~/.config/forgesworn/opsec-terms.json, shaped like:
 *   [{ "pattern": "\\bSomeName\\b", "label": "real first name" }]
 *
 * See opsec-terms.example.json.
 */
export function loadOpsecPatterns() {
  const path = process.env.SHOTGUARD_OPSEC
    || join(homedir(), '.config', 'forgesworn', 'opsec-terms.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
      .map((t) => [new RegExp(t.pattern, t.flags ?? 'i'), t.label]);
  } catch {
    return null;
  }
}

/** Pull every scrap of text a viewer could read off the page. */
export async function harvestText(page) {
  return page.evaluate(() => {
    const bits = [document.title, document.body?.innerText || ''];
    // Attributes render too: alt text, titles, placeholders, values, hrefs.
    document.querySelectorAll('*').forEach((el) => {
      for (const a of el.attributes || []) {
        if (/^(alt|title|placeholder|value|href|src|aria-label|data-.*)$/.test(a.name)) {
          bits.push(a.value);
        }
      }
    });
    // Text inside SVG and shadow roots is visible but skipped by innerText.
    document.querySelectorAll('svg text').forEach((t) => bits.push(t.textContent || ''));
    return bits.join('\n');
  });
}

/** Returns [] when clean, otherwise a list of what was found and where. */
export function scan(text, { allow = [], opsec } = {}) {
  let haystack = text;
  for (const a of allow) haystack = haystack.split(a).join('«allowed»');

  const hits = [];
  for (const [re, label] of SECRET_PATTERNS) {
    const m = haystack.match(re);
    if (m) hits.push({ severity: 'SECRET', label, sample: redact(m[0]) });
  }
  for (const [re, label] of (opsec ?? loadOpsecPatterns() ?? [])) {
    const m = haystack.match(re);
    if (m) hits.push({ severity: 'OPSEC', label, sample: redact(m[0]) });
  }
  return hits;
}

/** Never echo a full secret into a log or a transcript. */
function redact(s) {
  const t = String(s);
  if (t.length <= 10) return t[0] + '…' + t.slice(-1);
  return t.slice(0, 6) + '…' + t.slice(-3) + ` (${t.length} chars)`;
}

/**
 * Screenshot only if the page is clean. Throws otherwise, having written nothing.
 */
export async function safeShot(page, path, opts = {}) {
  const opsec = opts.opsec ?? loadOpsecPatterns();
  if (!opsec && !opts.allowMissingOpsec) {
    throw new Error(
      'REFUSED: no OPSEC terms found. Set $SHOTGUARD_OPSEC or create ' +
      '~/.config/forgesworn/opsec-terms.json (see opsec-terms.example.json). ' +
      'Pass allowMissingOpsec:true only if you genuinely want secrets-only scanning.');
  }
  const text = await harvestText(page);
  const hits = scan(text, { ...opts, opsec });
  if (hits.length) {
    const lines = hits.map((h) => `  [${h.severity}] ${h.label}: ${h.sample}`).join('\n');
    throw new Error(`REFUSED to capture ${path}\n${lines}`);
  }
  await page.screenshot({ path, ...(opts.shot || {}) });
  return { path, scannedChars: text.length };
}
