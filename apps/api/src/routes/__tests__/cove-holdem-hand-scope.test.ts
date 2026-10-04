/**
 * Security H1 (2026-09-30) — the Hold'em settle transaction locks the TABLE row,
 * then must load the HAND scoped to that table. Loading by hand id alone would
 * let a settle pair the locked table with another table's hand if a caller ever
 * passed mismatched ids. Source lock, same convention as the cove guard tests.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('cove-holdem settle loads the hand by (id, tableId) (security H1)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'cove-holdem.ts'), 'utf8');
  const settleTx = src.slice(
    src.indexOf('async function settleTransaction()'),
    src.indexOf("if (hand.fixtureRunId !== tableLock.fixture_run_id)"),
  );

  it('the settle transaction body is found after the table lock', () => {
    expect(settleTx.length).toBeGreaterThan(0);
    expect(settleTx).toContain('FROM holdem_tables WHERE id = ${tableId} FOR UPDATE');
  });

  it('the hand lookup is scoped to the locked table', () => {
    expect(settleTx).toContain(
      'where: and(eq(holdemHands.id, handId), eq(holdemHands.tableId, tableId))',
    );
    expect(settleTx).not.toContain('findFirst({ where: eq(holdemHands.id, handId) })');
  });
});
