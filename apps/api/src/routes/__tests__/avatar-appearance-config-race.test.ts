import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { agents } from '@clawville/database';
import { appearanceAgentConfigMerge } from '../../services/avatar-appearance-config';

const databaseUrl = process.env.DATABASE_URL;

test('a customization-only appearance edit does not write agent config', () => {
  expect(appearanceAgentConfigMerge({})).toBeUndefined();
});

(databaseUrl ? describe : describe.skip)('appearance config concurrency (Postgres)', () => {
  test('preserves a directive and cursor committed after the appearance snapshot', async () => {
    const target = new URL(databaseUrl!);
    // Only the CI test database or the coordinator's disposable audit database.
    if (!/^\/(?:[a-z0-9_]*test[a-z0-9_]*|cv_audit)$/i.test(target.pathname)) {
      throw new Error('Appearance race test requires an explicit test database');
    }
    const clientA = postgres(databaseUrl!, { prepare: false, max: 1 });
    const clientB = postgres(databaseUrl!, { prepare: false, max: 1 });
    const a = drizzle(clientA);
    const b = drizzle(clientB);
    const agentId = randomUUID();
    const schemaName = `appearance_race_${randomUUID().replaceAll('-', '')}`;
    const directive = { text: 'Ask Nori about the Bounty Board', setAt: new Date().toISOString(), setBy: 'chat-bar' };
    const initial = { harness: 'milady', modelKey: 'lobster', untouched: { value: 7 } };
    try {
      // A unique schema permits the actual Drizzle helper to run without
      // depending on unrelated migrations or touching public application rows.
      await clientA.unsafe(`CREATE SCHEMA "${schemaName}"`);
      await clientA.unsafe(`SET search_path TO "${schemaName}"`);
      await clientB.unsafe(`SET search_path TO "${schemaName}"`);
      await a.execute(sql`CREATE TABLE platform_agents (id uuid PRIMARY KEY, config jsonb NOT NULL)`);
      await a.execute(sql`INSERT INTO platform_agents (id, config) VALUES (${agentId}::uuid, ${JSON.stringify(initial)}::jsonb)`);

      await a.transaction(async (tx) => {
        const [stale] = await tx.select({ config: agents.config }).from(agents).where(eq(agents.id, agentId));
        expect(stale.config).toEqual(initial);
        // A separate connection commits both keys while the appearance
        // transaction still holds its earlier snapshot in application memory.
        await b.update(agents).set({ config: sql`${agents.config} || ${JSON.stringify({ currentDirective: directive, autonomyCursor: '91' })}::jsonb` })
          .where(eq(agents.id, agentId));

        // This is the old route's exact spread. It demonstrates why replacing
        // config from that snapshot loses both independently committed keys.
        const legacyReplacement = { ...stale.config, modelKey: 'lobster', agentCategory: 'openclaw' };
        expect(legacyReplacement).not.toHaveProperty('currentDirective');
        expect(legacyReplacement).not.toHaveProperty('autonomyCursor');

        await tx.update(agents).set({ config: appearanceAgentConfigMerge({ modelKey: 'lobster', agentCategory: 'openclaw' })! })
          .where(eq(agents.id, agentId));
      });
      const [persisted] = await b.select({ config: agents.config }).from(agents).where(eq(agents.id, agentId));
      expect(persisted.config).toEqual({ ...initial, agentCategory: 'openclaw', currentDirective: directive, autonomyCursor: '91' });
    } finally {
      try { await clientA.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); }
      finally { await Promise.all([clientA.end(), clientB.end()]); }
    }
  }, 20_000);
});
