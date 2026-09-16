import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../../..');

describe('Trading Floor migration contract', () => {
  test('0065 adds write-once baseline evidence with Drizzle parity', () => {
    const migration = readFileSync(
      resolve(repoRoot, 'packages/database/migrations/0065_trading_baseline_evidence.sql'),
      'utf8',
    );
    const schema = readFileSync(
      resolve(repoRoot, 'packages/database/src/schema/trading-fleet.ts'),
      'utf8',
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "baseline_evidence" jsonb');
    expect(migration).toContain('clawpump_agent_links_armed_needs_evidence');
    expect(migration).toContain('"armed" = false OR "baseline_evidence" IS NOT NULL');
    expect(schema).toContain("baselineEvidence: jsonb('baseline_evidence')");
    expect(schema).toContain("check('clawpump_agent_links_armed_needs_evidence'");
  });
});
