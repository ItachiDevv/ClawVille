import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type {
  ReconcileDashboardDeps,
} from '../dashboard';

const previousFingerprintSecret = process.env.FINGERPRINT_SECRET;
process.env.FINGERPRINT_SECRET ??= 'selfheal-dashboard-test-fixture';
const {
  dashboardRoutes,
  readReconcileDashboard,
  registerReconcileDashboardRoute,
} = await import('../dashboard');
const { expectedDashCookie } = await import('../../middleware/admin-only');
if (previousFingerprintSecret === undefined) delete process.env.FINGERPRINT_SECRET;
import type { ReconcileRow } from '../../services/x402-reconcile';
import type { AppContext } from '../../types';

const CREATED = '2026-09-01T12:00:00.000Z';
const ANCHOR = '2026-09-01T12:01:00.000Z';
const STAMP = { bucket: 'ambiguous', detail: 'Multiple candidates', action: null, at: ANCHOR };

function row(overrides: Partial<ReconcileRow> = {}): ReconcileRow {
  return {
    table: 'agent_payments', id: 'payment-1', usdCents: 200,
    createdAt: CREATED, settlingStartedAt: null, reconcileAnchorAt: ANCHOR,
    bountyHoldId: 'bounty-1',
    metadata: { reconcileReason: 'settle_ambiguous', autoReconcile: STAMP, privateValue: 'do-not-expose' },
    ...overrides,
  };
}

describe('read-only reconcile dashboard', () => {
  it('projects all three tables, durable bounty context, and narrow metadata without writes', async () => {
    const hold = {
      bountyId: 'bounty-1', bountyStatus: 'open' as const, holdStatus: 'open',
      settlementAttempt: 2, lastWedgeAlertAt: new Date(ANCHOR), wedgeAlertCount: 3,
    };
    const frozen = {
      bountyId: 'bounty-1', plan: { kind: 'frozen' as const, reason: 'ambiguous' as const },
      paymentId: 'payment-1', settlementAttempt: 2, lastWedgeAlertAt: new Date(ANCHOR), wedgeAlertCount: 3,
    };
    const calls: string[] = [];
    const result = await readReconcileDashboard({
      readRows: async () => {
        calls.push('readRows');
        return [row(), row({ table: 'ct_topups', id: 'topup-1', settlingStartedAt: CREATED, metadata: {} }),
          row({ table: 'x402_checkouts', id: 'checkout-1', reconcileAnchorAt: undefined, metadata: {} })];
      },
      readFrozen: async () => { calls.push('readFrozen'); return [frozen]; },
      readHolds: async (ids) => { calls.push('readHolds'); expect(ids).toEqual(['bounty-1']); return [hold]; },
    });
    expect(calls.sort()).toEqual(['readFrozen', 'readHolds', 'readRows']);
    expect(result.reconcileRows[0]).toEqual({
      table: 'agent_payments', id: 'payment-1', usdCents: 200, createdAt: CREATED,
      anchor: ANCHOR, reconcileReason: 'settle_ambiguous', recommendation: 'probe_merchant',
      autoReconcile: STAMP, bounty: hold,
    });
    expect(result.reconcileRows[1]).toMatchObject({ anchor: CREATED, autoReconcile: null, recommendation: 'manual_review' });
    expect(result.reconcileRows[1]).not.toHaveProperty('bounty');
    expect(result.reconcileRows[2]?.anchor).toBeNull();
    expect(result.tier1Frozen).toEqual([frozen]);
    expect(JSON.stringify(result)).not.toContain('do-not-expose');
  });

  it('handles missing holds and malformed stamps without leaking extra stamp fields', async () => {
    const result = await readReconcileDashboard({
      readRows: async () => [
        row({ metadata: { autoReconcile: { ...STAMP, hidden: 'private-stamp' } } }),
        row({ id: 'payment-2', metadata: { autoReconcile: 'malformed' } }),
      ],
      readFrozen: async () => [], readHolds: async () => [],
    });
    expect(result.reconcileRows[0]?.bounty).toBeNull();
    expect(result.reconcileRows[0]?.autoReconcile).toEqual(STAMP);
    expect(result.reconcileRows[1]?.autoReconcile).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-stamp');
  });

  it('rejects anonymous requests on the real dashboard route', async () => {
    const response = await dashboardRoutes.request('/reconcile');
    expect(response.status).toBe(401);
  });

  it('keeps the registered route private and uncached for an admin cookie', async () => {
    const cookie = expectedDashCookie();
    if (!cookie) throw new Error('Set FINGERPRINT_SECRET to a test fixture to test admin cookie access');
    const app = new Hono<AppContext>();
    const deps: ReconcileDashboardDeps = {
      readRows: async () => [], readFrozen: async () => [], readHolds: async () => [],
    };
    registerReconcileDashboardRoute(app, deps);
    const denied = await app.request('/reconcile');
    expect(denied.status).toBe(401);
    const response = await app.request('/reconcile', { headers: { cookie: `cv_dash=${cookie}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie, X-Clawville-Agent-Session');
    expect(await response.json()).toEqual({ reconcileRows: [], tier1Frozen: [] });
  });
});
