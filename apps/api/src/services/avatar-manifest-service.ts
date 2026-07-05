/**
 * Avatar-manifest export service — DB + network layer.
 *
 * Resolves everything a ClawVille Avatar Manifest needs (body bytes + hash,
 * owner wallet pubkey, identity pubkey, character + skillPack, equipped
 * cosmetics), then hands plain inputs to the DB-free core
 * (`avatar-manifest-core.ts`) to assemble + sign. See
 * `.claude/plans/agent-export-portability.md` §5/§6 (P1).
 *
 * INVARIANT: only PUBKEYS leave here (avatar wallet + identity). No secret key
 * is ever read or embedded — `getWalletAddress` reads the `avatars.wallet_
 * address` mirror without decrypting, and we select only `users.identity_pubkey`.
 */
import { and, eq } from '@clawville/database';
import {
  db,
  users,
  avatarSkins,
  cosmeticSkus,
  cosmeticVariants,
  type AvatarCharacterConfigJson,
} from '@clawville/database';
import {
  AGENT_MODEL_BODY_PATHS,
  DEFAULT_AGENT_HARNESS,
  DEFAULT_AGENT_MODEL,
  getAgentModel,
  type AgentHarness,
  type AgentModelBodyRef,
  type CamCosmeticRef,
  type ClawvilleAvatarManifest,
} from '@clawville/shared';
import { buildCharacterExport } from '@clawville/agent-runtime';
import { buildSkillPack } from './skill-pack-builder';
import { getWalletAddress } from './wallet-service';
import { validateOutboundUrlResolved } from './hatcher-config';
import { assembleManifestCore, sha256Hex, signManifestCore } from './avatar-manifest-core';

/**
 * Max body/cosmetic asset size we will fetch + hash. Registry VRMs are ~3-5MB;
 * 25MB is generous headroom. Caps memory on a hostile BYO URL that streams a
 * multi-GB body (the read is capped streaming, not a single arrayBuffer).
 */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Defense-in-depth cap on how many equipped cosmetics we fetch+hash per export. */
const MAX_COSMETICS = 24;

/** Structural subset of an `avatars` row the manifest export needs. */
export interface AvatarManifestSource {
  id: string;
  name: string;
  userId: string;
  modelKey: string;
  agentCategory: string;
  harness: string;
  avatarType: 'glb' | 'vrm';
  avatarUrl: string | null;
  characterConfig: AvatarCharacterConfigJson | null;
}

/** Thrown when an avatar has no resolvable exportable body. The route maps this to 422. */
export class NoExportableBodyError extends Error {
  constructor(modelKey: string) {
    super(`No exportable body asset is registered for modelKey '${modelKey}'.`);
    this.name = 'NoExportableBodyError';
  }
}

/**
 * Public ClawVille web origin (where the static body/cosmetic assets live).
 * MIRRORS `clawvilleWebOrigin()` in `routes/agent-registration.ts` — CORS_ORIGIN
 * first entry, falling back to the production domain.
 */
function webOrigin(): string {
  const raw = process.env.CORS_ORIGIN?.split(',')[0]?.trim();
  if (raw && /^https?:\/\//.test(raw)) return raw.replace(/\/+$/, '');
  return 'https://clawville.world';
}

/** Absolutise a web-relative asset path; pass full URLs through untouched. */
function absolutize(pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${webOrigin()}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

/**
 * Fetch with a streaming SIZE CAP so a hostile body can't exhaust memory.
 *
 * `allowRedirect=false` (the default for UNTRUSTED bring-your-own URLs) sets
 * `redirect:'manual'` and hard-fails on any 3xx. This is the load-bearing SSRF
 * control: `validateOutboundUrlResolved` only vets the FIRST hostname's DNS, so
 * a benign-but-redirecting host could 302 us into 169.254.169.254 / RFC1918.
 * Refusing to follow (same as agent-substrate-client / hatcher-session-webhook) closes
 * the redirect-hop + DNS-rebind-after-resolve bypass. Server-controlled registry
 * mirror fetches pass `allowRedirect=true`.
 */
async function fetchBytes(uri: string, allowRedirect: boolean): Promise<Uint8Array> {
  const res = await fetch(uri, { redirect: allowRedirect ? 'follow' : 'manual' });
  if (!allowRedirect && (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400))) {
    throw new Error(`Body asset ${uri} returned a redirect (${res.status}); refusing to follow for an untrusted URL.`);
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch body asset ${uri}: HTTP ${res.status}`);
  }
  // Fast reject via Content-Length when the server sends it.
  const len = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    throw new Error(`Body asset ${uri} too large (${len} bytes > ${MAX_BODY_BYTES}).`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) throw new Error(`Body asset ${uri} too large.`);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error(`Body asset ${uri} exceeds ${MAX_BODY_BYTES} bytes.`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Resolve an avatar's body URL + format. `byo` flags a bring-your-own URL
 * (`avatars.avatarUrl`) — that value can be set by a connecting agent/partner,
 * so its fetch MUST pass the SSRF guard (registry-mirror paths resolve against
 * the server-controlled web origin and are inherently safe).
 */
function resolveBodyRef(
  avatar: AvatarManifestSource,
): { uri: string; format: 'vrm' | 'glb'; byo: boolean } {
  if (avatar.avatarType === 'vrm' && avatar.avatarUrl) {
    return { uri: absolutize(avatar.avatarUrl), format: 'vrm', byo: true };
  }
  const ref = (AGENT_MODEL_BODY_PATHS as Record<string, AgentModelBodyRef>)[avatar.modelKey];
  if (!ref) throw new NoExportableBodyError(avatar.modelKey);
  return { uri: absolutize(ref.path), format: ref.format, byo: false };
}

/**
 * Resolve the avatar's EQUIPPED cosmetics into manifest refs. Best-effort:
 * any failure (query error, unreachable asset) returns `undefined` and the
 * cosmetics block is simply omitted — cosmetics are decorative, never an
 * integrity anchor, so they must not block a body+brain export. Shader/
 * registry-key cosmetics (no file) are skipped. `sha256` is best-effort per
 * item (omitted on fetch failure).
 */
async function resolveEquippedCosmetics(avatarId: string): Promise<CamCosmeticRef[] | undefined> {
  try {
    const rows = await db
      .select({
        slug: cosmeticSkus.slug,
        category: cosmeticSkus.category,
        scope: cosmeticSkus.scope,
        assetUrl: cosmeticVariants.assetUrl,
        rigType: cosmeticVariants.rigType,
      })
      .from(avatarSkins)
      .innerJoin(cosmeticSkus, eq(avatarSkins.skuId, cosmeticSkus.id))
      .innerJoin(cosmeticVariants, eq(cosmeticVariants.skuId, cosmeticSkus.id))
      .where(and(eq(avatarSkins.avatarId, avatarId), eq(avatarSkins.equipped, true)));

    // One ref per SKU: prefer a 'universal' variant, else the first file-backed
    // variant. Skip shader:/registry-key assets (no fetchable file).
    const bySku = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      // Only mesh assets are fetchable/embeddable. Skip shader:/registry-key
      // cosmetics (e.g. 'shader:aura-rainbow') — they have no file to hash.
      const isFile = /\.(glb|gltf|vrm)(\?|$)/i.test(r.assetUrl);
      if (!isFile) continue;
      const existing = bySku.get(r.slug);
      if (!existing || r.rigType === 'universal') bySku.set(r.slug, r);
    }

    const refs: CamCosmeticRef[] = [];
    // Cap the count (defense-in-depth): bound the per-export fetch fan-out even
    // if an avatar somehow accrues an unbounded number of equipped SKUs.
    for (const r of [...bySku.values()].slice(0, MAX_COSMETICS)) {
      const uri = absolutize(r.assetUrl);
      let sha256: string | undefined;
      try {
        // First-party assets (server origin) — following redirects is safe.
        sha256 = sha256Hex(await fetchBytes(uri, true));
      } catch {
        sha256 = undefined; // best-effort — omit on failure
      }
      refs.push({
        slot: r.category,
        skuSlug: r.slug,
        scope: r.scope,
        uri,
        rigType: r.rigType,
        ...(sha256 ? { sha256 } : {}),
      });
    }
    return refs.length ? refs : undefined;
  } catch {
    return undefined; // never let cosmetics break the export
  }
}

/**
 * Build a fully-signed ClawVille Avatar Manifest for an avatar. The caller
 * (route) is responsible for authz (owner check). Throws `NoExportableBodyError`
 * (→ 422) when the avatar's model has no body asset; rethrows fetch/sign errors.
 */
export async function buildSignedAvatarManifest(
  avatar: AvatarManifestSource,
  createdAtIso: string,
): Promise<ClawvilleAvatarManifest> {
  const bodyRef = resolveBodyRef(avatar);

  // SSRF guard: a bring-your-own `avatarUrl` can be set by a connecting agent/
  // partner, so DNS-resolve + reject private/loopback/link-local targets before
  // we fetch it (same guard the portal/cognition outbound paths use). Registry
  // bodies resolve against our own web origin and skip the guard.
  if (bodyRef.byo) {
    const check = await validateOutboundUrlResolved(bodyRef.uri);
    if (!check.ok) {
      throw new Error(`Avatar body URL rejected (${check.reason}).`);
    }
  }

  // Body bytes → content address. This is the integrity anchor; a failure here
  // fails the whole export (correct — a manifest without a verifiable body is
  // worthless). Untrusted BYO bodies never follow redirects (SSRF).
  const bytes = await fetchBytes(bodyRef.uri, !bodyRef.byo);
  const meshSha = sha256Hex(bytes);
  const kBytes = Math.round(bytes.length / 1024);

  // PUBKEYS ONLY — wallet mirror (no decrypt) + identity pubkey.
  const ownerAddress = await getWalletAddress('avatar', avatar.id);
  const [u] = await db
    .select({ identityPubkey: users.identityPubkey })
    .from(users)
    .where(eq(users.id, avatar.userId))
    .limit(1);
  const identityPubkey = u?.identityPubkey ?? null;

  const modelMeta = getAgentModel(avatar.modelKey) ?? DEFAULT_AGENT_MODEL;
  const harness: AgentHarness = (avatar.harness as AgentHarness) || DEFAULT_AGENT_HARNESS;

  const character = buildCharacterExport(
    { id: avatar.id, name: avatar.name, characterConfig: avatar.characterConfig ?? null },
    modelMeta,
    { harness },
  );
  const avatarKnowledge: string[] = avatar.characterConfig?.knowledge ?? [];
  const skillPack = buildSkillPack({ id: avatar.id, name: avatar.name }, avatarKnowledge);

  const cosmetics = await resolveEquippedCosmetics(avatar.id);

  const core = assembleManifestCore({
    avatarId: avatar.id,
    avatarName: avatar.name,
    mesh: { uri: bodyRef.uri, sha256: meshSha, format: bodyRef.format, kBytes },
    skeleton: bodyRef.format === 'vrm' ? 'vrm-humanoid' : 'custom',
    ownerAddress,
    createdAt: createdAtIso,
    cosmetics,
    identityPubkey,
    character,
    skillPack,
    provenance: {
      harness,
      agentCategory: avatar.agentCategory || modelMeta.category,
      modelKey: avatar.modelKey || modelMeta.key,
    },
  });

  return signManifestCore(core);
}
