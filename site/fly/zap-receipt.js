import { verifySignedEvent } from './vendor/nostr-verify.js';
const one = (event, name) => {
  const tags = event.tags.filter(t => t[0] === name);
  return tags.length === 1 ? tags[0][1] : null;
};
// NIP-57: a receipt is an assertion by the recipient's LNURL provider.
// A signature from an arbitrary Nostr key does not establish a payment.
export async function verifiedZap(event, { recipient, provider, lnurl }) {
  try {
    if (event.kind !== 9735 || !provider || event.pubkey !== provider || !await verifySignedEvent(event)) return null;
    if (one(event, 'p') !== recipient) return null;
    const invoice = one(event, 'bolt11'), description = one(event, 'description');
    if (typeof invoice !== 'string' || invoice.length > 10000 || !description) return null;
    const match = /^lnbc([1-9]\d*)([munp]?)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{100,}$/i.exec(invoice);
    if (!match) return null;
    const n = BigInt(match[1]), unit = match[2].toLowerCase();
    if (unit === 'p' && n % 10n) return null;
    const msat = unit === 'p' ? n / 10n : n * { '': 100000000000n, m: 100000000n, u: 100000n, n: 100n }[unit];
    if (msat <= 0 || msat > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const request = JSON.parse(description);
    if (request.kind !== 9734 || !await verifySignedEvent(request) || one(request, 'p') !== recipient) return null;
    const amount = one(request, 'amount'), target = one(request, 'lnurl');
    if (request.tags.filter(t => t[0] === 'amount').length > 1 || request.tags.filter(t => t[0] === 'lnurl').length > 1) return null;
    if (amount !== null && (!/^\d+$/.test(amount) || BigInt(amount) !== msat)) return null;
    if (target !== null && target.toLowerCase() !== lnurl.toLowerCase()) return null;
    return { invoice: invoice.toLowerCase(), sats: Number(msat) / 1000 };
  } catch { return null; }
}
