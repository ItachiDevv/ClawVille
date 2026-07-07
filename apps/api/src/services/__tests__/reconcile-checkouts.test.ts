/**
 * x402 SETTLE RECONCILER (Codex round-2 MEDIUM) — pure-classifier + apply-gate
 * unit tests. No DB, no chain. Proves each `reconcile` reason maps to the right
 * resolution recommendation and that the apply path is hard-gated OFF.
 */

// Scoped module-init env (the reconciler imports @clawville/database `db`).
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');

import { describe, it, expect, afterAll } from 'bun:test';
import {
  classifyReconcile,
  assertNoReconcileApply,
  type ReconcileRow,
} from '../x402-reconcile';

if (!DB_URL_WAS_SET) delete process.env.DATABASE_URL;

function row(metadata: ReconcileRow['metadata'], overrides: Partial<ReconcileRow> = {}): ReconcileRow {
  return {
    table: 'x402_checkouts',
    id: 'row-1',
    usdCents: 500,
    createdAt: '2026-07-07T00:00:00.000Z',
    settlingStartedAt: '2026-07-07T00:01:00.000Z',
    metadata,
    ...overrides,
  };
}

describe('reconcile classifier', () => {
  it('capture_lost + signature ⇒ verify_signature / capture_fulfill (money is ours)', () => {
    const r = classifyReconcile(row({ reconcileReason: 'capture_lost', spentTxSignature: 'SIG_A' }));
    expect(r.kind).toBe('verify_signature');
    if (r.kind !== 'verify_signature') return;
    expect(r.recommend).toBe('capture_fulfill');
    expect(r.spentTxSignature).toBe('SIG_A');
  });

  it('signature_conflict + signature ⇒ verify_signature / refund_required (contested)', () => {
    const r = classifyReconcile(row({ reconcileReason: 'signature_conflict', spentTxSignature: 'SIG_B' }));
    expect(r.kind).toBe('verify_signature');
    if (r.kind !== 'verify_signature') return;
    expect(r.recommend).toBe('refund_required');
  });

  it('settle_ambiguous ⇒ probe_merchant with the ¢-peg atomic amount + payer + window', () => {
    const r = classifyReconcile(
      row({ reconcileReason: 'settle_ambiguous', expectedPayer: 'PayerX' }, { usdCents: 500 }),
    );
    expect(r.kind).toBe('probe_merchant');
    if (r.kind !== 'probe_merchant') return;
    expect(r.expectedUsdcAtomic).toBe('5000000'); // 500¢ → 5 USDC → 5_000_000 atomic
    expect(r.expectedPayer).toBe('PayerX');
    expect(r.sinceIso).toBe('2026-07-07T00:01:00.000Z'); // settlingStartedAt preferred
  });

  it('stale_settling ⇒ probe_merchant; falls back to createdAt when no settlingStartedAt', () => {
    const r = classifyReconcile(row({ reconcileReason: 'stale_settling' }, { settlingStartedAt: null }));
    expect(r.kind).toBe('probe_merchant');
    if (r.kind !== 'probe_merchant') return;
    expect(r.expectedPayer).toBeNull();
    expect(r.sinceIso).toBe('2026-07-07T00:00:00.000Z'); // createdAt fallback
  });

  it('a signature-carrying reason WITHOUT a signature ⇒ manual_review', () => {
    expect(classifyReconcile(row({ reconcileReason: 'capture_lost' })).kind).toBe('manual_review');
    expect(classifyReconcile(row({ reconcileReason: 'signature_conflict' })).kind).toBe('manual_review');
  });

  it('an unrecognized reason ⇒ manual_review', () => {
    expect(classifyReconcile(row({ reconcileReason: 'who_knows' })).kind).toBe('manual_review');
    expect(classifyReconcile(row({})).kind).toBe('manual_review');
  });
});

describe('reconcile apply gate', () => {
  const prior = process.env.RECONCILE_APPLY;
  afterAll(() => {
    if (prior === undefined) delete process.env.RECONCILE_APPLY;
    else process.env.RECONCILE_APPLY = prior;
  });

  it('assertNoReconcileApply is a no-op while unset/false', () => {
    delete process.env.RECONCILE_APPLY;
    expect(() => assertNoReconcileApply()).not.toThrow();
    process.env.RECONCILE_APPLY = 'false';
    expect(() => assertNoReconcileApply()).not.toThrow();
  });

  it('assertNoReconcileApply THROWS when apply is enabled (Codex-gated)', () => {
    process.env.RECONCILE_APPLY = 'true';
    expect(() => assertNoReconcileApply()).toThrow(/Codex-review-gated/);
  });
});
