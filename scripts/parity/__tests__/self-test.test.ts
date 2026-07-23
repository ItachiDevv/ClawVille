import { describe, expect, test } from 'bun:test';
import { runHarnessSelfTest } from '../self-test';

describe('harness lie detector', () => {
  test('accepts correct payload and detects exactly the injected wrong card', async () => {
    const result = await runHarnessSelfTest();
    expect(result.pass).toBe(true);
    expect(result.output).toBe([
      'SELF-TEST correct recorded payload: PASS',
      'SELF-TEST injected wrong card: FAIL (expected; lie detected)',
      'SELF-TEST overall: PASS',
    ].join('\n'));
  });
});
