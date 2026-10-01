import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Security F4 (2026-10-01): agent_session_tickets.identity_key stored the RAW
// identityKey (an account credential). mintSessionTicket, the only writer, now
// stores `sha256:` + hex sha256 of `${identityType}:${identityKey}`; migration
// 0073 rewrites older rows to the same shape.

let inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];

const realDatabase = await import('@clawville/database');
// Copy taken BEFORE the mock, restored in afterAll (no leak into later files).
const realDatabaseCopy = { ...realDatabase };
afterAll(() => {
  mock.module('@clawville/database', () => realDatabaseCopy);
});
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;
const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'insert') {
      return (table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          inserted.push({ table, values });
        },
      });
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});
mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const { mintSessionTicket, ticketIdentityKeyDigest } = await import('../session-ticket-service');

const USER_ID = '81111111-1111-4111-8111-111111111111';

beforeEach(() => {
  inserted = [];
});

describe('session ticket identity key is never stored raw', () => {
  test('ticketIdentityKeyDigest is sha256:<hex of "type:key">', () => {
    const expected = createHash('sha256').update('custom:my-secret-identity-key').digest('hex');
    expect(ticketIdentityKeyDigest('custom', 'my-secret-identity-key')).toBe(`sha256:${expected}`);
    expect(ticketIdentityKeyDigest('custom', 'k')).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Same key, other type: other digest (same namespace as users.identity_fingerprint).
    expect(ticketIdentityKeyDigest('hermes', 'k')).not.toBe(ticketIdentityKeyDigest('custom', 'k'));
  });

  test('mintSessionTicket stores the digest, not the raw key', async () => {
    const rawKey = 'raw-secret-identity-key-that-must-not-be-stored';
    await mintSessionTicket({ userId: USER_ID, identityType: 'custom', identityKey: rawKey, issuedToAgentSession: 'ag-test-session', issuedToAgentId: 'ticket-hash-agent' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe(realDatabase.agentSessionTickets);
    const stored = inserted[0].values.identityKey;
    expect(stored).toBe(ticketIdentityKeyDigest('custom', rawKey));
    expect(JSON.stringify(inserted[0].values)).not.toContain(rawKey);
    // The session bearer is digested too (pre-existing rule), never raw.
    expect(JSON.stringify(inserted[0].values)).not.toContain('ag-test-session');
  });

  test('a raw key that is already 64 hex characters is still hashed', async () => {
    const hexKey = 'a'.repeat(64);
    await mintSessionTicket({ userId: USER_ID, identityType: 'openclaw', identityKey: hexKey });
    expect(inserted[0].values.identityKey).toBe(ticketIdentityKeyDigest('openclaw', hexKey));
    expect(inserted[0].values.identityKey).not.toBe(hexKey);
  });

  test('mintSessionTicket is the only writer of agent_session_tickets in apps/api/src', () => {
    const root = join(import.meta.dir, '..', '..');
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === '__tests__' || name === 'node_modules') continue;
          walk(full);
        } else if (name.endsWith('.ts')) {
          const src = readFileSync(full, 'utf8');
          if (/insert\(\s*agentSessionTickets\s*\)|INSERT\s+INTO\s+"?agent_session_tickets/i.test(src)) writers.push(full);
          if (/update\(\s*agentSessionTickets\s*\)[\s\S]{0,200}identityKey/.test(src)) writers.push(`${full} (update identityKey)`);
        }
      }
    };
    walk(root);
    expect(writers.map((w) => w.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/'))).toEqual([
      'src/services/session-ticket-service.ts',
    ]);
  });
});
