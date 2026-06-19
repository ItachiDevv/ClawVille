/**
 * Deterministic JSON canonicalisation (`clawville-jcs-v1`).
 *
 * Keys sorted, no whitespace, arrays order-preserved, primitives via
 * `JSON.stringify`. Two machines signing the same object MUST produce the
 * same bytes, or signatures won't verify across deploys.
 *
 * ⚠️ BYTE-PARITY INVARIANT: this function is a verbatim clone of
 * `canonicalJson` in `apps/api/src/services/service-issuer.ts`. The service
 * issuer signs manifests via `signPayload()` (which canonicalises with its
 * own copy), and consumers verify with THIS copy — so the two MUST stay
 * byte-identical. We cannot import the issuer's copy here because
 * `service-issuer.ts` is protected partner-surface and keeps `canonicalJson`
 * private; the duplication is deliberate and is pinned by the parity test
 * `apps/api/src/services/__tests__/avatar-manifest.test.ts`
 * (`canonicalize(core) === signPayload(core).body`). If you change one, change
 * both — the test will fail loudly otherwise.
 *
 * Pure: JSON only, no Node built-ins, no crypto — safe to ship in the web
 * bundle via the `@clawville/shared` barrel.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}
