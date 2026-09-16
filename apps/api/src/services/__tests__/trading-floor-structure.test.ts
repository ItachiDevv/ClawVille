import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRADE_REFUSAL_COPY, TRADE_UNSCORED_REASONS } from '@clawville/shared';

const root = resolve(import.meta.dir, '../../../../..');

describe('Trading Floor structural invariants', () => {
  test('keeps migration constraint and index names in the Drizzle schema', () => {
    const migration = readFileSync(resolve(root, 'packages/database/migrations/0063_trading_floor.sql'), 'utf8');
    const schema = readFileSync(resolve(root, 'packages/database/src/schema/trading.ts'), 'utf8');
    const names = [...migration.matchAll(/(?:CONSTRAINT\s+|CREATE(?: UNIQUE)? INDEX IF NOT EXISTS\s+)((?:trading_wallets|verified_trades)_[a-z0-9_]+)/gi)].map((match) => match[1]);
    for (const name of new Set(names)) expect(schema).toContain(name);
  });

  test('keeps refusal copy within founder language rules', () => {
    for (const sentence of Object.values(TRADE_REFUSAL_COPY)) {
      expect(sentence).not.toMatch(/[–—]/);
      expect(sentence.toLowerCase()).not.toContain('casino');
      expect(sentence).not.toMatch(/\bCT\b/);
    }
  });

  test('keeps the seven-value unscored vocabulary in the SQL check', () => {
    const schema = readFileSync(resolve(root, 'packages/database/src/schema/trading.ts'), 'utf8');
    for (const reason of TRADE_UNSCORED_REASONS) expect(schema).toContain(`'${reason}'`);
  });
});
