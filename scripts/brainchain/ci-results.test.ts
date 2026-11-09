import { test, expect } from 'bun:test';
import { parseSuiteResult } from './ci-results';
test('required PostgreSQL lane refuses partial and zero execution', () => {
  expect(() => parseSuiteResult('1 pass\n1 skip\n0 fail', true)).toThrow('tests skipped');
  expect(() => parseSuiteResult('0 pass\n2 skip', true)).toThrow('No tests executed');
  expect(parseSuiteResult('2 pass\n0 fail', true)).toEqual({ passed: 2, skipped: 0 });
  expect(parseSuiteResult('1 pass\n1 skip', false)).toEqual({ passed: 1, skipped: 1 });
});
