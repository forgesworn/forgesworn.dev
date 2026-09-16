import { schnorr } from '@noble/curves/secp256k1.js';

const hex = (s, length) => typeof s === 'string' && s.length === length && /^[0-9a-f]+$/.test(s);
const bytes = s => Uint8Array.from(s.match(/../g), pair => parseInt(pair, 16));

export async function verifySignedEvent(event) {
  try {
    if (!event || !hex(event.id, 64) || !hex(event.pubkey, 64) || !hex(event.sig, 128)) return false;
    if (!Number.isSafeInteger(event.kind) || event.kind < 0 || !Number.isSafeInteger(event.created_at) || event.created_at < 0) return false;
    if (typeof event.content !== 'string' || event.content.length > 8000 || !Array.isArray(event.tags) || event.tags.length > 128) return false;
    if (event.tags.some(tag => !Array.isArray(tag) || tag.length > 16 || tag.some(value => typeof value !== 'string' || value.length > 4096))) return false;
    const serialised = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialised)));
    const id = Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
    return id === event.id && schnorr.verify(bytes(event.sig), digest, bytes(event.pubkey));
  } catch { return false; }
}
