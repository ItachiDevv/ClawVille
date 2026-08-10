import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

const migrationPath = resolve(
  import.meta.dir,
  '../../../../../../packages/database/migrations/0057b_bounty_gas_sponsorship.sql',
);
const migration = await Bun.file(migrationPath).text();

type CaptureRow = {
  status: 'in_flight' | 'succeeded' | 'broadcast_unknown';
  requestId: string | null;
  signature: string | null;
  serializedTransaction: string | null;
  blockhash: string | null;
  lastValidBlockHeight: bigint | null;
};

// Mirrors sap_escrow_withdrawals_capture_shape so representative deployed rows
// remain explicit in the test instead of relying on a regex alone.
function captureShape(row: CaptureRow): boolean {
  const empty =
    row.signature == null &&
    row.serializedTransaction == null &&
    row.blockhash == null &&
    row.lastValidBlockHeight == null;
  const full =
    row.signature != null &&
    row.serializedTransaction != null &&
    row.blockhash != null &&
    row.lastValidBlockHeight != null;
  const legacyTerminal =
    (row.status === 'succeeded' || row.status === 'broadcast_unknown') &&
    row.serializedTransaction == null &&
    row.blockhash == null &&
    row.lastValidBlockHeight == null;
  return legacyTerminal || (row.status === 'in_flight' && (empty || full)) ||
    (row.status !== 'in_flight' && full);
}

describe('0057b withdrawal capture migration', () => {
  it('keeps expired-missing gas quarantines valid and cap-counted', () => {
    expect(migration).toContain(
      "status IN ('pending', 'unconfirmed', 'quarantined', 'confirmed', 'failed')",
    );
  });

  it('B4 — validates representative 0023b terminal history without weakening new rows', () => {
    expect(captureShape({
      status: 'succeeded',
      requestId: '0023c-era-request-id',
      signature: 'legacy-success-signature',
      serializedTransaction: null,
      blockhash: null,
      lastValidBlockHeight: null,
    })).toBe(true);
    expect(captureShape({
      status: 'broadcast_unknown',
      requestId: null,
      signature: null,
      serializedTransaction: null,
      blockhash: null,
      lastValidBlockHeight: null,
    })).toBe(true);
    expect(captureShape({
      status: 'in_flight',
      requestId: 'new-sendable-row',
      signature: 'partial-is-invalid',
      serializedTransaction: null,
      blockhash: null,
      lastValidBlockHeight: null,
    })).toBe(false);

    expect(migration).toMatch(/status IN \('succeeded', 'broadcast_unknown'\)[\s\S]*?serialized_transaction IS NULL/);
    expect(migration).toMatch(/status IN \('succeeded', 'broadcast_unknown'\)[\s\S]*?signature IS NOT NULL[\s\S]*?serialized_transaction IS NOT NULL/);
  });

  it('B4 — every 0057b DDL operation is guarded for an idempotent double apply', () => {
    expect(migration).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/);
    expect(migration).not.toMatch(/CREATE (?:TABLE|INDEX|UNIQUE INDEX)(?! IF NOT EXISTS)/);
    for (const constraint of [
      'bounties_composition_refund_claim_lease_pair',
      'bounties_composition_refund_reconcile_has_signature',
      'sap_escrow_withdrawals_capture_shape',
      'sap_escrow_withdrawals_claim_lease_pair',
    ]) {
      expect(migration).toMatch(
        new RegExp(`IF NOT EXISTS \\([\\s\\S]*?conname = '${constraint}'[\\s\\S]*?ADD CONSTRAINT ${constraint}`),
      );
    }
  });
});
