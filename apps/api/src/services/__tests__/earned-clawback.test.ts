import { describe, expect, it } from 'bun:test';
import {
  avatars,
  clawTokenTransactions,
  covenantActionRecords,
  earnClawbacks,
  earnedAccountedLedger,
  earnedLotConsumptions,
} from '@clawville/database';
import { clawBackEarnedMint } from '../claw-token-ledger';

function renderSql(q: unknown): { text: string; params: unknown[] } {
  const out = { text: '', params: [] as unknown[] };
  const walk = (node: unknown): void => {
    for (const chunk of (node as { queryChunks?: unknown[] })?.queryChunks ?? []) {
      const name = (chunk as { constructor?: { name?: string } })?.constructor?.name;
      if (name === 'StringChunk') {
        const value = (chunk as { value: unknown }).value;
        out.text += Array.isArray(value) ? value.join('') : String(value);
      } else if (name === 'SQL') walk(chunk);
      else if (name === 'Param') {
        out.params.push((chunk as { value: unknown }).value);
        out.text += '?';
      } else if (name === 'String' || name === 'Number' || name === 'BigInt') {
        out.params.push((chunk as { valueOf(): unknown }).valueOf());
        out.text += '?';
      }
    }
  };
  walk(q);
  return out;
}

function makeHarness() {
  const avatar = {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: 'user-1',
    claw_tokens: 30,
    soft_balance: 0,
    bought_balance: 0,
    earned_balance: 30,
  };
  const event = {
    id: '22222222-2222-4222-8222-222222222222',
    earner_avatar_id: avatar.id,
    vclaw_minted: 100,
    mint_lot_id: '33333333-3333-4333-8333-333333333333',
    clawed: false,
  };
  const lot = { id: event.mint_lot_id, backing_kind: 'backed' as const, remaining_vclaw: 30 };
  const backing = { remaining: 300_000n, released: 700_000n };
  let clawback: Record<string, unknown> | null = null;
  let ledgerInserts = 0;
  let covenantInserts = 0;
  const accounted = new Set<string>(['historical-mint', 'historical-spend']);

  const execute = async (query: unknown): Promise<unknown[]> => {
    const { text, params } = renderSql(query);
    if (text.includes('pg_advisory_xact_lock')) return [];
    if (text.includes('FROM earn_clawbacks')) return clawback ? [{
      id: clawback.id,
      earn_event_id: clawback.earnEventId,
      requested_vclaw: clawback.requestedVclaw,
      debited_vclaw: clawback.debitedVclaw,
      deficit_vclaw: clawback.deficitVclaw,
      released_usdc_atomic: clawback.releasedUsdcAtomic,
      ledger_debit_id: clawback.ledgerDebitId,
    }] : [];
    if (text.includes('SELECT earner_avatar_id FROM earn_events')) {
      return [{ earner_avatar_id: event.earner_avatar_id }];
    }
    if (text.includes('SELECT user_id, claw_tokens')) return [{ ...avatar }];
    if (text.includes('SELECT earned_balance FROM avatars')) {
      return [{ earned_balance: avatar.earned_balance }];
    }
    if (text.includes('FROM claw_token_transactions t')) return [];
    if (text.includes('COALESCE(SUM(remaining_vclaw)')) {
      return [{ amount: lot.remaining_vclaw.toString() }];
    }
    if (text.includes('JOIN earned_mint_lots l') && text.includes('FOR UPDATE OF e, l')) {
      return [{ ...event }];
    }
    if (text.includes('FROM earned_mint_lots l') && text.includes('FOR UPDATE OF l')) {
      return lot.remaining_vclaw > 0 ? [{ ...lot }] : [];
    }
    if (text.includes('UPDATE earned_mint_lots') && text.includes('remaining_vclaw = remaining_vclaw -')) {
      const amount = Number(params[0]);
      if (lot.remaining_vclaw < amount) return [];
      lot.remaining_vclaw -= amount;
      return [{ id: lot.id }];
    }
    if (text.includes('UPDATE earned_backing') && text.includes('remaining_usdc_atomic = remaining_usdc_atomic -')) {
      const amount = BigInt(String(params[0]));
      if (backing.remaining < amount) return [];
      backing.remaining -= amount;
      backing.released += amount;
      return [{ id: 'backing-1' }];
    }
    if (text.includes('remaining_usdc_atomic::text AS remaining')) {
      return [{ remaining: backing.remaining.toString() }];
    }
    if (text.includes('UPDATE earned_backing') && text.includes('released_usdc_atomic')) {
      backing.released += backing.remaining;
      backing.remaining = 0n;
      return [];
    }
    if (text.includes('UPDATE earned_mint_lots') && text.includes("release_reason = 'admin_clawback'")) {
      lot.remaining_vclaw = 0;
      return [];
    }
    if (text.includes('UPDATE earn_events') && text.includes('clawed_back_at')) {
      event.clawed = true;
      return [];
    }
    throw new Error(`unhandled clawback SQL: ${text.replace(/\s+/g, ' ').trim()}`);
  };

  const tx = {
    execute,
    update(table: unknown) {
      if (table !== avatars) throw new Error('unexpected update table');
      return {
        set(payload: Record<string, unknown>) {
          return {
            async where() {
              avatar.claw_tokens = Number(payload.clawTokens);
              avatar.soft_balance = Number(payload.softBalance);
              avatar.bought_balance = Number(payload.boughtBalance);
              avatar.earned_balance = Number(payload.earnedBalance);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(payload: Record<string, unknown>) {
          const returning = async () => {
            if (table === clawTokenTransactions) {
              ledgerInserts += 1;
              return [{ id: `ledger-${ledgerInserts}` }];
            }
            if (table === covenantActionRecords) {
              covenantInserts += 1;
              return [{ id: `covenant-${covenantInserts}` }];
            }
            throw new Error('unexpected returning insert');
          };
          const onConflictDoNothing = async () => {
            if (table === earnedAccountedLedger) accounted.add(String(payload.ledgerId));
          };
          if (table === earnClawbacks) clawback = payload;
          if (table === earnedLotConsumptions) {
            // Exact backing release is asserted from the backing state below.
          }
          return {
            returning,
            onConflictDoNothing,
            then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
              return Promise.resolve(undefined).then(resolve, reject);
            },
          };
        },
      };
    },
  };
  const database = {
    async transaction<T>(fn: (inner: typeof tx) => Promise<T>): Promise<T> { return fn(tx); },
  };
  return {
    database,
    avatar,
    event,
    lot,
    backing,
    getClawback: () => clawback,
    ledgerInserts: () => ledgerInserts,
    covenantInserts: () => covenantInserts,
  };
}

describe('E2 administrative EARNED claw-back', () => {
  it('is idempotent, debits available EARNED, records deficit, and releases exact remaining backing', async () => {
    const h = makeHarness();
    const input = {
      earnEventId: h.event.id,
      adminUserId: 'founder-user',
      reason: 'confirmed sybil settlement',
    };
    const first = await clawBackEarnedMint(input, h.database as never);
    const replay = await clawBackEarnedMint(input, h.database as never);

    expect(first).toMatchObject({
      requestedVclaw: 100,
      debitedVclaw: 30,
      deficitVclaw: 70,
      releasedUsdcAtomic: '300000',
      replay: false,
    });
    expect(replay).toMatchObject({ ...first, replay: true });
    expect(h.avatar.earned_balance).toBe(0);
    expect(h.avatar.claw_tokens).toBe(0);
    expect(h.lot.remaining_vclaw).toBe(0);
    expect(h.backing).toEqual({ remaining: 0n, released: 1_000_000n });
    expect(h.event.clawed).toBe(true);
    expect(h.ledgerInserts()).toBe(1);
    expect(h.covenantInserts()).toBe(1);
    expect(h.getClawback()).toMatchObject({ requestedVclaw: 100, deficitVclaw: 70 });
  });
});
