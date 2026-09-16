import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

describe('trade_token grammar and floor-state parity', () => {
  test('manual and tool schema name every forbidden reason delimiter', () => {
    const manual = read('apps/api/src/services/skill-protocol.ts');
    const tools = read('packages/shared/src/constants/building-tools.ts');
    const route = read('apps/api/src/routes/trading-floor.ts');
    const rule = 'parentheses, brackets, commas, or equals signs';
    expect(manual).toContain(rule);
    expect(tools).toContain(rule);
    expect(route).toContain('/[,=()[\\]]/');
  });

  test('private floor state returns the submitted reason under one field name', () => {
    const state = read('apps/api/src/services/autonomous-trading-targets.ts');
    expect(state).toContain('lastTrades: { at: string; verdict: string; reason: string }[]');
    expect(state).toContain('reason: row.reason.slice(0, 120)');
    expect(state).not.toContain('detail: row.detail.slice(0, 120)');
  });
});
