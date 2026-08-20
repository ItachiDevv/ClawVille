import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { loadSapConfig, SOLANA_MAINNET_GENESIS_HASH } from '../sap/sap-config';
import { withTier2AppRole, withTier2OpsRole } from './tier2-db';
import { Tier2Error } from './tier2-errors';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

function integerEnv(name: string, fallback: number, floor: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isSafeInteger(parsed) && parsed >= floor ? parsed : fallback;
}

export const tier2EscrowEnabled = (): boolean => process.env.SAP_USDC_ESCROW_ENABLED === 'true';
export const tier2DriverEnabled = (): boolean => process.env.TIER2_DRIVER_ENABLED === 'true';
export const tier2ClaimTtlMs = (): number => {
  const raw = process.env.TIER2_CLAIM_TTL_MS;
  if (raw === undefined) return 86_400_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 600_000) throw new Tier2Error('claim_ttl_invalid');
  return parsed;
};
export const tier2ClaimSweepMs = (): number => integerEnv('TIER2_CLAIM_SWEEP_MS', 300_000, 60_000);
export const tier2DriverPollMs = (): number => integerEnv('TIER2_DRIVER_POLL_MS', 300_000, 30_000);
export const tier2FeeUsdCents = (): number => integerEnv('TIER2_FEE_USD_CENTS', 500, 1);
export const tier2FeeAtomic = (): bigint => BigInt(tier2FeeUsdCents()) * 10_000n;

export function tier2Role(kind: 'app' | 'ops'): string {
  const role = (process.env[kind === 'app' ? 'TIER2_APP_DB_ROLE' : 'TIER2_OPS_DB_ROLE'] ??
    (kind === 'app' ? 'clawville_app' : 'clawville_ops')).trim();
  if (!IDENTIFIER.test(role)) {
    throw new Tier2Error('tier2_role_unconfigured', `Invalid Tier-2 ${kind} role identifier.`);
  }
  return role;
}

export function tier2ClusterGenesis(): string {
  return loadSapConfig().cluster === 'mainnet' ? SOLANA_MAINNET_GENESIS_HASH : DEVNET_GENESIS_HASH;
}

export function tier2Mint(): PublicKey {
  return loadSapConfig().usdcMint;
}

export function tier2MerchantWallet(): PublicKey {
  const raw = process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY?.trim();
  if (!raw) throw new Tier2Error('tier2_boot_merchant_wallet_missing');
  let key: PublicKey;
  try {
    key = new PublicKey(raw);
  } catch (cause) {
    throw new Tier2Error('tier2_boot_merchant_wallet_invalid', undefined, { cause });
  }
  if (!PublicKey.isOnCurve(key.toBytes())) {
    throw new Tier2Error('tier2_boot_merchant_wallet_invalid', 'Merchant wallet must be on-curve.');
  }
  return key;
}

type ProviderConfig = {
  url?: string;
  operatorIdentity?: string;
  failureDomain?: string;
  archival?: boolean;
};

function assertProviderConfig(): void {
  let providers: ProviderConfig[];
  try {
    providers = JSON.parse(process.env.TIER2_RPC_PROVIDERS ?? '[]') as ProviderConfig[];
  } catch (cause) {
    throw new Tier2Error('tier2_boot_provider_config_invalid', undefined, { cause });
  }
  if (!Array.isArray(providers)) {
    throw new Tier2Error('tier2_boot_provider_config_invalid');
  }
  const active = providers.filter((provider) => provider.archival === true);
  const hasIndependentPair = active.some((left, index) => active.slice(index + 1).some((right) =>
    String(left.url ?? '').trim() !== String(right.url ?? '').trim()
      && String(left.operatorIdentity ?? '').trim() !== String(right.operatorIdentity ?? '').trim()
      && String(left.failureDomain ?? '').trim() !== String(right.failureDomain ?? '').trim()
  ));
  if (
    active.length < 2 ||
    active.some((provider) => !provider.url?.trim() || !provider.operatorIdentity?.trim() || !provider.failureDomain?.trim()) ||
    !hasIndependentPair
  ) {
    throw new Tier2Error('tier2_boot_provider_independence_missing');
  }
}

/** Crash-loud when the otherwise-dark Tier-2 rail is explicitly enabled. */
export async function assertTier2BootReady(): Promise<void> {
  if (!tier2EscrowEnabled()) return;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const opsUrl = process.env.TIER2_OPS_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Tier2Error('tier2_boot_database_url_missing');
  if (!opsUrl) throw new Tier2Error('ops_surface_unconfigured');
  if (databaseUrl === opsUrl) throw new Tier2Error('tier2_boot_ops_connection_not_separate');
  const key = process.env.VANITY_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Tier2Error('tier2_boot_encryption_key_invalid');
  tier2MerchantWallet();
  assertProviderConfig();

  await withTier2AppRole(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT
        pg_catalog.to_regprocedure('public.tier2_driver_transition(uuid,varchar,varchar,varchar,varchar,uuid)') IS NOT NULL
          AND pg_catalog.to_regprocedure('public.tier2_reconciler_transition(uuid,varchar,varchar,varchar,varchar,uuid)') IS NOT NULL
          AND pg_catalog.to_regprocedure('public.tier2_payout_transition(uuid,varchar,varchar,varchar,varchar,uuid)') IS NOT NULL
          AND pg_catalog.to_regprocedure('public.tier2_bind_hunter_payee(uuid,varchar)') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_attribute
            WHERE attrelid='public.bounty_attempts'::regclass
              AND attname='claim_expires_at' AND attnum>0 AND NOT attisdropped
          ) AS ready,
        current_user=${tier2Role('app')} AS current_role_ok,
        EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='clawville_tier2_owner') AS owner_exists,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles login
          WHERE login.rolname=session_user AND login.rolcanlogin
            AND NOT login.rolinherit AND NOT login.rolsuper AND NOT login.rolbypassrls
            AND pg_catalog.pg_has_role(session_user,${tier2Role('app')},'MEMBER')
            AND NOT pg_catalog.pg_has_role(session_user,${tier2Role('ops')},'MEMBER')
        ) AS login_posture_ok,
        EXISTS (
          SELECT 1 FROM public.tier2_rpc_providers p1
          JOIN public.tier2_rpc_providers p2
            ON ROW(p1.provider_id,p1.identity_version)<ROW(p2.provider_id,p2.identity_version)
           AND p1.endpoint_fingerprint<>p2.endpoint_fingerprint
           AND p1.operator_identity<>p2.operator_identity
           AND p1.failure_domain<>p2.failure_domain
          WHERE p1.active IS TRUE AND p1.archival IS TRUE
            AND p2.active IS TRUE AND p2.archival IS TRUE
        ) AS active_providers_ok
    `);
    if (rows[0]?.ready !== true) throw new Tier2Error('tier2_boot_schema_incomplete');
    if (rows[0]?.active_providers_ok !== true) throw new Tier2Error('tier2_boot_provider_independence_missing');
    if (rows[0]?.owner_exists !== true || rows[0]?.current_role_ok !== true || rows[0]?.login_posture_ok !== true) {
      throw new Tier2Error('tier2_boot_app_role_posture_invalid');
    }
  });
  await withTier2OpsRole(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT current_user=${tier2Role('ops')} AS current_role_ok,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles login
          WHERE login.rolname=session_user AND login.rolcanlogin
            AND NOT login.rolinherit AND NOT login.rolsuper AND NOT login.rolbypassrls
            AND pg_catalog.pg_has_role(session_user,${tier2Role('ops')},'MEMBER')
            AND NOT pg_catalog.pg_has_role(session_user,${tier2Role('app')},'MEMBER')
        ) AS login_posture_ok
    `);
    if (rows[0]?.current_role_ok !== true || rows[0]?.login_posture_ok !== true) {
      throw new Tier2Error('tier2_boot_ops_role_posture_invalid');
    }
  });
}
