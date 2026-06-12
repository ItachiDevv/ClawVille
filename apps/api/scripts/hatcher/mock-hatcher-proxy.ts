/**
 * MOCK-HATCHER PROXY — staging-only pre-ship harness (2026-06-12).
 *
 * Stands in for Hatcher's per-agent cognition proxy so we can prove the OUTBOUND
 * cognition seam end-to-end: when a registered Hatcher agent needs to speak, the
 * ClawVille API POSTs to `{proxyBaseUrl}/integrations/clawville/agents/:id/chat`
 * with a Bearer scoped token + an ed25519 signature over the canonical-JSON body
 * (X-Clawville-Issuer-Pubkey / X-Clawville-Signature), verifiable against
 * `{api-base}/.well-known/clawville-issuer.json`. This server implements that
 * endpoint, VERIFIES both, logs every request, and replies a fixed OpenAI-style
 * chat completion whose content carries exactly one `[ACTION: emote(name=wave)]`
 * tag (so the sim's Hatcher [ACTION:] dispatcher visibly makes the body wave).
 *
 * SSRF ALLOWLIST CAVEAT (read before running): the API will only CALL this proxy
 * if its host is in `HATCHER_PROXY_ALLOWED_HOSTS` (default: hatcher.host,
 * api.hatcher.host) AND the host resolves to a PUBLIC IP (the register-time guard
 * is `validateHatcherProxyUrlResolved`, which rejects RFC1918 / loopback /
 * link-local). So this proxy must run on a PUBLIC, allowlisted host to be reached
 * from staging — e.g. a tailnet/ngrok/public box whose hostname you add to
 * `HATCHER_PROXY_ALLOWED_HOSTS` on the staging API. If you cannot expose a public
 * host, the client half (register/stats/delete) still passes; only the cognition
 * round-trip is unverifiable, which the run book documents.
 *
 * SIGNATURE CONTRACT (must match service-issuer.ts signPayload exactly):
 *   - canonical = JSON with object keys SORTED recursively (canonicalJson).
 *   - digest    = sha256(canonical).
 *   - signature = base58( ed25519_detached(digest, issuerSecretKey) ).
 *   We re-derive canonicalJson from the PARSED body and compare; if the partner
 *   (us) ever changed key order, this would catch it. We ALSO verify over the
 *   exact received bytes as a fallback, because the API sends `signed.body`
 *   (already canonical) verbatim — both should agree.
 *
 * Run:  bun run apps/api/scripts/hatcher/mock-hatcher-proxy.ts \
 *         --api-base https://api-staging.clawville.world \
 *         --scoped-token <the token you'll register with> \
 *         [--port 8799]
 * The --scoped-token MUST equal the cognition.scopedToken you register the mock
 * agent with (mock-hatcher-client.ts prints/uses a random one — pass the same
 * value to both, or read it from the client's logged register body).
 */

import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function arg(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const API_BASE = (arg('--api-base') ?? process.env.MOCK_HATCHER_API_BASE ?? '').replace(/\/+$/, '');
const SCOPED_TOKEN = arg('--scoped-token') ?? process.env.MOCK_HATCHER_SCOPED_TOKEN ?? null;
const PORT = Number.parseInt(arg('--port') ?? process.env.PORT ?? '8799', 10);

if (!API_BASE) {
  console.error('FATAL: --api-base is required (to fetch the issuer pubkey from /.well-known/clawville-issuer.json)');
  process.exit(2);
}
if (!SCOPED_TOKEN) {
  console.error('FATAL: --scoped-token is required (must equal the cognition.scopedToken the mock agent registered with)');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Canonical JSON — byte-identical to services/service-issuer.ts canonicalJson
// ---------------------------------------------------------------------------
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Issuer pubkey — fetched once, cached. The API publishes its ed25519 pubkey at
// /.well-known/clawville-issuer.json (purpose 'partner-cognition-callback').
// ---------------------------------------------------------------------------
let cachedIssuerPubkey: string | null = null;
async function getIssuerPubkey(): Promise<string | null> {
  if (cachedIssuerPubkey) return cachedIssuerPubkey;
  try {
    const res = await fetch(`${API_BASE}/.well-known/clawville-issuer.json`);
    if (!res.ok) {
      console.error(`[proxy] issuer well-known fetch failed: ${res.status}`);
      return null;
    }
    const info = (await res.json()) as { publicKey?: string; algorithm?: string; purposes?: string[] };
    if (info.algorithm !== 'ed25519' || typeof info.publicKey !== 'string') {
      console.error(`[proxy] issuer well-known has unexpected shape: ${JSON.stringify(info)}`);
      return null;
    }
    if (!info.purposes?.includes('partner-cognition-callback')) {
      console.warn(`[proxy] issuer pubkey does not list 'partner-cognition-callback' purpose — proceeding anyway`);
    }
    cachedIssuerPubkey = info.publicKey;
    console.log(`[proxy] issuer pubkey loaded: ${cachedIssuerPubkey}`);
    return cachedIssuerPubkey;
  } catch (err) {
    console.error(`[proxy] issuer well-known fetch threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signature verification over the body. The API signs sha256(canonicalJson(body))
// and sends `signed.body` (the canonical string) verbatim. We try BOTH the exact
// received bytes and a re-canonicalization of the parsed body — they must agree.
// ---------------------------------------------------------------------------
function verifyClawvilleSignature(rawBody: string, parsedBody: unknown, pubkeyB58: string, sigB58: string): boolean {
  let pub: Uint8Array;
  let sig: Uint8Array;
  try {
    pub = bs58.decode(pubkeyB58);
    sig = bs58.decode(sigB58);
  } catch {
    return false;
  }
  if (pub.length !== 32 || sig.length !== 64) return false;
  const candidates = new Set<string>([rawBody]);
  try {
    candidates.add(canonicalJson(parsedBody));
  } catch {
    /* parsedBody not canonicalizable — rawBody alone */
  }
  for (const material of candidates) {
    const digest = createHash('sha256').update(material).digest();
    if (nacl.sign.detached.verify(new Uint8Array(digest), sig, pub)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const CHAT_PATH_RE = /^\/integrations\/clawville\/agents\/([^/]+)\/chat$/;
let requestCount = 0;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const ts = new Date().toISOString();

    // Health probe.
    if (url.pathname === '/health') {
      return Response.json({ ok: true, requests: requestCount });
    }

    const m = url.pathname.match(CHAT_PATH_RE);
    if (req.method !== 'POST' || !m) {
      console.log(`[proxy] ${ts} ${req.method} ${url.pathname} → 404 (unhandled)`);
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    requestCount += 1;
    const agentId = decodeURIComponent(m[1]);
    const rawBody = await req.text();
    const auth = req.headers.get('authorization');
    const pubHeader = req.headers.get('x-clawville-issuer-pubkey');
    const sigHeader = req.headers.get('x-clawville-signature');

    // 1. Bearer must equal the scoped token this proxy was started with.
    const bearerOk = auth === `Bearer ${SCOPED_TOKEN}`;
    if (!bearerOk) {
      console.log(`[proxy] ${ts} chat agent=${agentId} → 401 BAD BEARER (got=${auth ? auth.slice(0, 18) + '…' : 'none'})`);
      return Response.json({ error: 'bad_bearer' }, { status: 401 });
    }

    // 2. ClawVille issuer signature must verify against the published pubkey.
    const issuerPubkey = await getIssuerPubkey();
    let parsed: unknown = null;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      /* leave null */
    }
    const sigOk =
      !!issuerPubkey &&
      !!pubHeader &&
      !!sigHeader &&
      pubHeader === issuerPubkey &&
      verifyClawvilleSignature(rawBody, parsed, pubHeader, sigHeader);

    if (!sigOk) {
      console.log(
        `[proxy] ${ts} chat agent=${agentId} → 401 BAD SIGNATURE (pubMatches=${pubHeader === issuerPubkey} hasSig=${!!sigHeader})`,
      );
      return Response.json({ error: 'bad_signature' }, { status: 401 });
    }

    // Log the verified cognition request (the proof the seam works end-to-end).
    const playerMessage =
      isObj(parsed) && isObj(parsed.clawville) && typeof parsed.clawville.playerMessage === 'string'
        ? parsed.clawville.playerMessage
        : '(none)';
    const model = isObj(parsed) && typeof parsed.model === 'string' ? parsed.model : '(none)';
    console.log(
      `[proxy] ${ts} chat agent=${agentId} → 200 VERIFIED (bearer ok, sig ok) model=${model} playerMessage="${String(playerMessage).slice(0, 80)}"`,
    );

    // 3. Reply a fixed chat completion carrying exactly one whitelisted ACTION.
    const reply = {
      id: `mock-${requestCount}`,
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello from the mock Hatcher proxy! [ACTION: emote(name=wave)]',
          },
          finish_reason: 'stop',
        },
      ],
    };
    return Response.json(reply);
  },
});

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

console.log('=== mock-Hatcher proxy (staging pre-ship harness) ===');
console.log(`listening   : http://0.0.0.0:${server.port}`);
console.log(`chat path   : POST /integrations/clawville/agents/:agentId/chat`);
console.log(`api-base    : ${API_BASE} (issuer pubkey source)`);
console.log(`scoped-token: ${SCOPED_TOKEN.slice(0, 8)}… (Bearer must match this)`);
console.log('');
console.log('REMINDER: the staging API only reaches this proxy if its PUBLIC host is in');
console.log('HATCHER_PROXY_ALLOWED_HOSTS and resolves to a public IP. See run-mock-e2e.md.');
console.log('Waiting for cognition callbacks…');

// Warm the issuer pubkey cache so the first real callback isn't delayed.
void getIssuerPubkey();
