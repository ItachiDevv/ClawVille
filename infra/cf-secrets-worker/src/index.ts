/**
 * ClawVille Secrets Store Worker — wrap/unwrap per-row DEKs with an
 * envelope KEK that lives exclusively in Cloudflare.
 *
 * Exposes two endpoints, both bearer-token protected:
 *
 *   POST /wrap    — body: { plaintextDek: base64 }
 *                   response: { wrappedDek: base64 }
 *   POST /unwrap  — body: { wrappedDek: base64 }
 *                   response: { plaintextDek: base64 }
 *
 * The wrap algorithm is RFC 3394 AES-KeyWrap (AES-KW), selected because
 * it round-trips cleanly in WebCrypto on Cloudflare Workers and because
 * the ciphertext shape is fixed-length (8 bytes of padding on a 32-byte
 * DEK = 40 bytes output), which keeps the `wallets.dek_wrapped` column
 * size predictable.
 *
 * Bindings (set via `wrangler secret put`):
 *   - KEK_V1         — 32-byte master key. Base64 (44 chars with pad) or
 *                      hex (64 chars) auto-detected by length.
 *   - WORKER_BEARER  — opaque bearer token. Must match the Authorization
 *                      header on every call. Rotate independently of the
 *                      KEK by issuing a new bearer + deploying.
 *
 * This Worker has NO other authority. It can encrypt/decrypt arbitrary
 * 32-byte inputs using KEK_V1, which is why access is gated behind a
 * rotatable bearer. If the bearer leaks, rotate `WORKER_BEARER`; if the
 * KEK leaks, rotate `KEK_V1` and re-wrap every row server-side.
 */

export interface Env {
  KEK_V1: string;
  WORKER_BEARER: string;
}

// ---------------------------------------------------------------------------
// Key material helpers
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** Accept either a 64-char hex or a base64 encoding of a 32-byte key. */
function decodeKek(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  const bytes = base64ToBytes(trimmed);
  if (bytes.length !== 32) {
    throw new Error(`KEK must be exactly 32 bytes; got ${bytes.length}`);
  }
  return bytes;
}

async function importKek(env: Env): Promise<CryptoKey> {
  const raw = decodeKek(env.KEK_V1);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-KW' }, false, [
    'wrapKey',
    'unwrapKey',
  ]);
}

/**
 * Wrap an arbitrary 32-byte DEK using AES-KW. WebCrypto requires a
 * CryptoKey input for wrapKey, so we `importKey(raw, AES-GCM)` the plain
 * DEK first as a "never-actually-used for GCM" handle, then wrap it.
 */
async function wrapDek(kek: CryptoKey, plaintextDek: Uint8Array): Promise<Uint8Array> {
  if (plaintextDek.length !== 32) {
    throw new Error(`DEK must be 32 bytes; got ${plaintextDek.length}`);
  }
  const dekKey = await crypto.subtle.importKey(
    'raw',
    plaintextDek,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt'],
  );
  const wrapped = await crypto.subtle.wrapKey('raw', dekKey, kek, { name: 'AES-KW' });
  // wrapKey returns ArrayBuffer when exporting 'raw'. The type union
  // (ArrayBuffer | JsonWebKey) is a WebCrypto quirk — the 'raw' format
  // branch always resolves to ArrayBuffer.
  return new Uint8Array(wrapped as ArrayBuffer);
}

async function unwrapDek(kek: CryptoKey, wrapped: Uint8Array): Promise<Uint8Array> {
  const dekKey = await crypto.subtle.unwrapKey(
    'raw',
    wrapped,
    kek,
    { name: 'AES-KW' },
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt'],
  );
  const raw = await crypto.subtle.exportKey('raw', dekKey);
  // Same ArrayBuffer | JsonWebKey WebCrypto type quirk as wrapDek.
  return new Uint8Array(raw as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkAuth(req: Request, env: Env): Response | null {
  const auth = req.headers.get('Authorization') ?? '';
  if (!env.WORKER_BEARER) return json({ error: 'worker_misconfigured' }, 500);
  if (auth !== `Bearer ${env.WORKER_BEARER}`) return json({ error: 'unauthorized' }, 401);
  return null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const denied = checkAuth(req, env);
    if (denied) return denied;

    const url = new URL(req.url);

    let body: { plaintextDek?: string; wrappedDek?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    let kek: CryptoKey;
    try {
      kek = await importKek(env);
    } catch (err) {
      return json({ error: 'kek_import_failed', detail: String(err) }, 500);
    }

    try {
      if (url.pathname === '/wrap') {
        if (!body.plaintextDek) return json({ error: 'plaintextDek_required' }, 400);
        const plain = base64ToBytes(body.plaintextDek);
        const wrapped = await wrapDek(kek, plain);
        return json({ wrappedDek: bytesToBase64(wrapped) });
      }

      if (url.pathname === '/unwrap') {
        if (!body.wrappedDek) return json({ error: 'wrappedDek_required' }, 400);
        const wrapped = base64ToBytes(body.wrappedDek);
        const plain = await unwrapDek(kek, wrapped);
        return json({ plaintextDek: bytesToBase64(plain) });
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      return json({ error: 'crypto_op_failed', detail: String(err) }, 500);
    }
  },
};
