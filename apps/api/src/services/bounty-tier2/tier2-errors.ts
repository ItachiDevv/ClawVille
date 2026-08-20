import { HTTPException } from 'hono/http-exception';

export type Tier2ErrorCode =
  | `tier2_${string}`
  | 'not_open'
  | 'already_claimed'
  | 'not_tier2'
  | 'payee_provenance_unverified'
  | 'claim_ttl_invalid'
  | 'ops_surface_unconfigured'
  | 'tier2_role_unconfigured';

const TIER2_CODE = /(tier2_[a-z0-9_]+|ops_surface_unconfigured|payee_provenance_unverified|claim_ttl_invalid)/i;

export class Tier2Error extends Error {
  readonly code: Tier2ErrorCode;

  constructor(code: Tier2ErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = 'Tier2Error';
    this.code = code;
  }
}

export function asTier2Error(error: unknown): Tier2Error {
  if (error instanceof Tier2Error) return error;
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(TIER2_CODE);
  const code = (match?.[1]?.toLowerCase() ?? 'tier2_internal') as Tier2ErrorCode;
  return new Tier2Error(code, message, { cause: error });
}

export function tier2ErrorHttpStatus(code: Tier2ErrorCode): 400 | 403 | 404 | 409 | 500 | 503 {
  if (code === 'not_tier2' || code === 'not_open' || code === 'claim_ttl_invalid') return 400;
  if (code === 'tier2_bounty_not_found') return 404;
  if (
    code === 'ops_surface_unconfigured' ||
    code === 'tier2_role_unconfigured' ||
    code.includes('provider') ||
    code.includes('boot_')
  ) return 503;
  if (code.includes('forbidden') || code.includes('unauthorized')) return 403;
  if (
    code === 'already_claimed' ||
    code.includes('stale') ||
    code.includes('conflict') ||
    code.includes('already') ||
    code.includes('frozen') ||
    code.includes('illegal_state') ||
    code.includes('not_allowed') ||
    code.includes('guard_failed') ||
    code.includes('not_proven')
  ) return 409;
  if (code === 'payee_provenance_unverified' || code.includes('invalid')) return 400;
  return 500;
}

export function toTier2HttpException(error: unknown): HTTPException {
  const tier2 = asTier2Error(error);
  return new HTTPException(tier2ErrorHttpStatus(tier2.code), {
    message: tier2.message,
    cause: tier2,
  });
}
