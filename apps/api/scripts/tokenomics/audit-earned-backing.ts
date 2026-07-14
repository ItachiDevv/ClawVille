/**
 * Read-only, one-shot EARNED backing audit.
 *
 * This module imports the audit service directly: it never imports the API
 * entrypoint, opens routes, or starts any worker. The isolated process must
 * opt in with the literal gate value; this does not change a server's env.
 */
if (process.env.TOKENOMICS_REDEEM_ENABLED !== 'true') {
  console.error(JSON.stringify({
    audit: 'earned_backing',
    status: { ok: false, error: 'redeem_disabled' },
  }));
  process.exit(2);
}

async function main(): Promise<number> {
  try {
    // Dynamic import keeps even service/database module initialization behind
    // the isolated-process gate; the API entrypoint is never imported.
    const { auditEarnedBackingSolvency } = await import(
      '../../src/services/earned-redemption'
    );
    const result = await auditEarnedBackingSolvency();
    const ok = result.solvent
      && result.integrityMismatchCount === 0
      && result.indeterminateFundingCount === 0;

    console.log(JSON.stringify({
      audit: 'earned_backing',
      walletPubkey: result.walletPubkey,
      amounts: {
        onchainUsdcAtomic: result.onchainUsdcAtomic,
        outstandingBackingUsdcAtomic: result.outstandingBackingUsdcAtomic,
        retainedExitFeesUsdcAtomic: result.retainedExitFeesUsdcAtomic,
        unsweptBuyPrincipalUsdcAtomic: result.unsweptBuyPrincipalUsdcAtomic,
        requiredUsdcAtomic: result.requiredUsdcAtomic,
      },
      status: {
        ok,
        solvent: result.solvent,
        integrityMismatchCount: result.integrityMismatchCount,
        integrityReasons: result.integrityReasons,
        indeterminateFundingCount: result.indeterminateFundingCount,
        indeterminateReasons: result.indeterminateReasons,
      },
    }, null, 2));
    return ok ? 0 : 1;
  } catch {
    // Never echo database/RPC error objects: they may contain connection URLs.
    console.error(JSON.stringify({
      audit: 'earned_backing',
      status: { ok: false, error: 'audit_failed' },
    }));
    return 2;
  }
}

// The database package intentionally exposes no global pool-close primitive;
// one-shot operator scripts in this repo terminate after awaited work instead.
process.exit(await main());
