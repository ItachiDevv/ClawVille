import { describe, expect, test } from 'bun:test';
import {
  hasSourceCommitMismatch,
  normalizeSourceCommit,
} from './stale-client-version';

describe('stale client version comparison', () => {
  test('normalizes absent and whitespace-only commits to null', () => {
    expect(normalizeSourceCommit(undefined)).toBeNull();
    expect(normalizeSourceCommit(null)).toBeNull();
    expect(normalizeSourceCommit('   ')).toBeNull();
  });

  test('is disabled when either commit is unavailable', () => {
    expect(hasSourceCommitMismatch(null, 'server')).toBe(false);
    expect(hasSourceCommitMismatch('client', null)).toBe(false);
  });

  test('does not flag matching commits', () => {
    expect(hasSourceCommitMismatch('abc123', 'abc123')).toBe(false);
  });

  test('flags two available, different commits', () => {
    expect(hasSourceCommitMismatch('client-commit', 'server-commit')).toBe(
      true,
    );
  });
});
