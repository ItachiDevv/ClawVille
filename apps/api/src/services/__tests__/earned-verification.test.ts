import { beforeEach, describe, expect, it } from 'bun:test';
import { runPayerVerificationBatch, type PayerInspection } from '../earned-import';

type Event = {
  id: string;
  earner_avatar_id: string;
  payer_wallet: string;
  gross_usdc_atomic: string;
  epoch_start: Date;
  payer_verification: 'pending' | 'verified' | 'rejected';
  payer_cluster_key: string;
  first_funder_wallet: string | null;
  verification_reason: string | null;
  backing_network: 'mainnet' | 'devnet';
};

function renderSql(q: unknown): { text: string; params: unknown[] } {
  const out = { text: '', params: [] as unknown[] };
  const walk = (node: unknown): void => {
    const chunks = (node as { queryChunks?: unknown[] })?.queryChunks;
    if (!Array.isArray(chunks)) return;
    for (const chunk of chunks) {
      if (chunk === null) {
        out.params.push(null);
        out.text += '?';
        continue;
      }
      const name = (chunk as { constructor?: { name?: string } })?.constructor?.name;
      if (name === 'StringChunk') {
        const value = (chunk as { value: unknown }).value;
        out.text += Array.isArray(value) ? value.join('') : String(value);
      } else if (name === 'SQL') {
        walk(chunk);
      } else if (name === 'Param') {
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

function makeHarness(events: Event[]) {
  const counters = new Map<string, bigint>();
  const mappings = new Map<string, string>();
  const lots = new Map(events.map((event) => [event.id, {
    backingKind: 'backed' as 'backed' | 'none',
    remainingVclaw: Number(BigInt(event.gross_usdc_atomic) / 10_000n),
  }]));
  const backing = new Map(events.map((event) => [event.id, {
    remaining: BigInt(event.gross_usdc_atomic),
    released: 0n,
  }]));

  const execute = async (query: unknown): Promise<unknown[]> => {
    const { text, params } = renderSql(query);
    if (text.includes('FROM earn_events') && text.includes("payer_verification = 'pending'")
      && text.includes('ORDER BY created_at')) {
      return events.filter((event) => event.payer_verification === 'pending').map((event) => ({
        id: event.id,
        earner_avatar_id: event.earner_avatar_id,
        payer_wallet: event.payer_wallet,
        gross_usdc_atomic: event.gross_usdc_atomic,
        epoch_start: event.epoch_start,
        backing_network: event.backing_network,
      }));
    }
    if (text.includes('FROM avatars') && text.includes('FOR UPDATE')) return [{ id: params[0] }];
    if (text.includes('FROM earn_events') && text.includes('FOR UPDATE')) {
      const event = events.find((row) => row.id === String(params[0]));
      return event?.payer_verification === 'pending' ? [{ id: event.id }] : [];
    }
    if (text.includes('pg_advisory_xact_lock')) return [];
    if (text.includes('AS clawville_owned')) return [{ clawville_owned: false }];
    if (text.includes('FROM earn_payer_clusters')) {
      const first = mappings.get(`${String(params[0])}|${String(params[1])}`);
      return first ? [{ first_funder_wallet: first }] : [];
    }
    if (text.includes('FROM earn_cluster_epoch_counters')) {
      const key = `${String(params[0])}|${String(params[1])}|${String(params[2])}|${String(params[3])}`;
      const value = counters.get(key);
      return value === undefined ? [] : [{ usdc_atomic: value.toString() }];
    }
    if (text.includes('INSERT INTO earn_payer_clusters')) {
      const key = `${String(params[0])}|${String(params[1])}`;
      if (!mappings.has(key)) mappings.set(key, String(params[2]));
      return [];
    }
    if (text.includes('INSERT INTO earn_cluster_epoch_counters')) {
      const key = `${String(params[0])}|${String(params[1])}|${String(params[2])}|${String(params[3])}`;
      counters.set(key, (counters.get(key) ?? 0n) + BigInt(String(params[4])));
      return [];
    }
    if (text.includes("SET payer_verification = 'verified'")) {
      const event = events.find((row) => row.id === String(params[params.length - 1]));
      if (event?.payer_verification === 'pending') {
        event.payer_verification = 'verified';
        event.payer_cluster_key = String(params[0]);
        event.first_funder_wallet = String(params[1]);
        event.verification_reason = 'heuristics_v1_passed';
      }
      return [];
    }
    if (text.includes("SET payer_verification = 'rejected'")) {
      // The reason/id are stable trailing params even when optional fields vary.
      const event = events.find((row) => row.id === String(params[params.length - 1]));
      if (event?.payer_verification === 'pending') {
        event.payer_verification = 'rejected';
        event.first_funder_wallet = params[0] == null ? null : String(params[0]);
        event.verification_reason = String(params[params.length - 2]);
      }
      return [];
    }
    if (text.includes("UPDATE earned_mint_lots SET backing_kind = 'none'")) {
      const eventId = String(params[1]);
      const lot = lots.get(eventId);
      if (lot) lot.backingKind = 'none';
      return [];
    }
    if (text.includes('UPDATE earned_backing b')) {
      const eventId = String(params[0]);
      const row = backing.get(eventId);
      if (row) {
        row.released += row.remaining;
        row.remaining = 0n;
      }
      return [];
    }
    throw new Error(`unhandled verifier SQL: ${text.replace(/\s+/g, ' ').trim()}`);
  };

  const database = {
    execute,
    async transaction<T>(fn: (tx: { execute: typeof execute }) => Promise<T>): Promise<T> {
      return fn({ execute });
    },
  };
  return { database, execute, events, counters, mappings, lots, backing };
}

function event(
  id: string,
  payer: string,
  grossUsdcAtomic: string,
  backingNetwork: 'mainnet' | 'devnet' = 'devnet',
): Event {
  return {
    id,
    earner_avatar_id: '11111111-1111-4111-8111-111111111111',
    payer_wallet: payer,
    gross_usdc_atomic: grossUsdcAtomic,
    epoch_start: new Date('2026-07-10T00:00:00.000Z'),
    payer_verification: 'pending',
    payer_cluster_key: payer,
    first_funder_wallet: null,
    verification_reason: null,
    backing_network: backingNetwork,
  };
}

function requireFirstFunder(row: Event): string {
  if (row.first_funder_wallet === null) {
    throw new Error(`expected verified first-funder mapping for event ${row.id}`);
  }
  return row.first_funder_wallet;
}

describe('E2 payer verification state machine', () => {
  beforeEach(() => {
    process.env.TOKENOMICS_EARN_ENABLED = 'true';
    process.env.TOKENOMICS_EARN_PAIR_CAP_USD = '100';
  });

  it('merges sibling payer wallets by first funder and enforces the cluster/earner cap', async () => {
    const first = event('00000000-0000-4000-8000-000000000001', 'Wallet11111111111111111111111111111111111', '60000000');
    const sibling = event('00000000-0000-4000-8000-000000000002', 'Wallet22222222222222222222222222222222222', '50000000');
    const h = makeHarness([first, sibling]);
    const inspectedNetworks: string[] = [];
    const inspect = async (_payer: string, network: string): Promise<PayerInspection> => {
      inspectedNetworks.push(network);
      return {
        verdict: 'verified',
        firstFunderWallet: 'Funder11111111111111111111111111111111111',
        walletAgeSeconds: 1_000_000,
        signatureCount: 20,
      };
    };

    const result = await runPayerVerificationBatch({
      database: h.database as never,
      inspectPayerWallet: inspect,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(result).toEqual({ processed: 2, verified: 1, rejected: 1 });
    expect(first.payer_verification).toBe('verified');
    expect(sibling.payer_verification).toBe('rejected');
    expect(sibling.verification_reason).toBe('first_funder_cluster_cap_exceeded');
    expect(h.mappings.get(`devnet|${first.payer_wallet}`)).toBe(requireFirstFunder(first));
    expect(h.mappings.get(`devnet|${sibling.payer_wallet}`)).toBe(requireFirstFunder(sibling));
    expect(h.lots.get(sibling.id)?.backingKind).toBe('none');
    expect(h.backing.get(sibling.id)).toEqual({ remaining: 0n, released: 50_000_000n });
    expect(inspectedNetworks).toEqual(['devnet', 'devnet']);
  });

  it('transitions pending to rejected while preserving spendable EARNED balance and releasing backing', async () => {
    const rejected = event('00000000-0000-4000-8000-000000000003', 'Wallet33333333333333333333333333333333333', '1000000');
    const h = makeHarness([rejected]);
    const spendableBefore = h.lots.get(rejected.id)!.remainingVclaw;

    const result = await runPayerVerificationBatch({
      database: h.database as never,
      inspectPayerWallet: async () => ({
        verdict: 'rejected', reason: 'payer_too_young', walletAgeSeconds: 60, signatureCount: 1,
      }),
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(result).toEqual({ processed: 1, verified: 0, rejected: 1 });
    expect(rejected.payer_verification).toBe('rejected');
    expect(rejected.verification_reason).toBe('payer_too_young');
    expect(h.lots.get(rejected.id)).toEqual({
      backingKind: 'none',
      remainingVclaw: spendableBefore,
    });
    expect(h.backing.get(rejected.id)).toEqual({ remaining: 0n, released: 1_000_000n });
  });

  it('keeps devnet and mainnet payer/cluster cap domains isolated', async () => {
    const devnet = event('00000000-0000-4000-8000-000000000004', 'Wallet44444444444444444444444444444444444', '60000000', 'devnet');
    const mainnet = event('00000000-0000-4000-8000-000000000005', 'Wallet44444444444444444444444444444444444', '60000000', 'mainnet');
    const h = makeHarness([devnet, mainnet]);
    const result = await runPayerVerificationBatch({
      database: h.database as never,
      inspectPayerWallet: async () => ({
        verdict: 'verified',
        firstFunderWallet: 'Funder44444444444444444444444444444444444',
        walletAgeSeconds: 1_000_000,
        signatureCount: 20,
      }),
    });
    expect(result).toEqual({ processed: 2, verified: 2, rejected: 0 });
    expect(h.mappings.has(`devnet|${devnet.payer_wallet}`)).toBe(true);
    expect(h.mappings.has(`mainnet|${mainnet.payer_wallet}`)).toBe(true);
  });

  it('persists a cap-rejected payer mapping and rejects a later conflicting inspection', async () => {
    const seed = event('00000000-0000-4000-8000-000000000006', 'WalletSeed555555555555555555555555555555555', '60000000');
    const capped = event('00000000-0000-4000-8000-000000000007', 'WalletRace555555555555555555555555555555555', '50000000');
    const changed = event('00000000-0000-4000-8000-000000000008', capped.payer_wallet, '1000000');
    const h = makeHarness([seed, capped, changed]);
    let raceInspections = 0;
    await runPayerVerificationBatch({
      database: h.database as never,
      inspectPayerWallet: async (payer) => {
        if (payer === capped.payer_wallet) raceInspections += 1;
        return {
          verdict: 'verified',
          firstFunderWallet: payer === capped.payer_wallet && raceInspections > 1
            ? 'ChangedFunder55555555555555555555555555555555'
            : 'OriginalFunder5555555555555555555555555555555',
          walletAgeSeconds: 1_000_000,
          signatureCount: 20,
        };
      },
    });

    expect(capped.verification_reason).toBe('first_funder_cluster_cap_exceeded');
    expect(changed.verification_reason).toBe('first_funder_mapping_conflict');
    expect(h.mappings.get(`devnet|${capped.payer_wallet}`))
      .toBe('OriginalFunder5555555555555555555555555555555');
  });

  it('serializes concurrent conflicting first-funder observations for one payer', async () => {
    const payer = 'WalletConcurrent6666666666666666666666666666666';
    const first = event('00000000-0000-4000-8000-000000000009', payer, '1000000');
    const second = event('00000000-0000-4000-8000-000000000010', payer, '1000000');
    second.earner_avatar_id = '22222222-2222-4222-8222-222222222222';
    const h = makeHarness([first, second]);
    const lockTails = new Map<string, Promise<void>>();

    const databaseFor = (target: Event) => ({
      async execute(query: unknown): Promise<unknown[]> {
        const { text } = renderSql(query);
        if (text.includes('FROM earn_events') && text.includes("payer_verification = 'pending'")
          && text.includes('ORDER BY created_at')) {
          return [{
            id: target.id,
            earner_avatar_id: target.earner_avatar_id,
            payer_wallet: target.payer_wallet,
            gross_usdc_atomic: target.gross_usdc_atomic,
            epoch_start: target.epoch_start,
            backing_network: target.backing_network,
          }];
        }
        return h.execute(query);
      },
      async transaction<T>(fn: (tx: { execute(query: unknown): Promise<unknown[]> }) => Promise<T>): Promise<T> {
        const releases: Array<() => void> = [];
        const execute = async (query: unknown): Promise<unknown[]> => {
          const { text, params } = renderSql(query);
          if (!text.includes('pg_advisory_xact_lock')) return h.execute(query);
          const key = String(params[0]);
          const prior = lockTails.get(key) ?? Promise.resolve();
          let release!: () => void;
          const held = new Promise<void>((resolve) => { release = resolve; });
          lockTails.set(key, prior.then(() => held));
          await prior;
          releases.push(release);
          return [];
        };
        try {
          return await fn({ execute });
        } finally {
          for (const release of releases.reverse()) release();
        }
      },
    });

    let inspections = 0;
    let releaseInspectionBarrier!: () => void;
    const inspectionBarrier = new Promise<void>((resolve) => { releaseInspectionBarrier = resolve; });
    const inspect = (funder: string) => async (): Promise<PayerInspection> => {
      inspections += 1;
      if (inspections === 2) releaseInspectionBarrier();
      await inspectionBarrier;
      return {
        verdict: 'verified', firstFunderWallet: funder,
        walletAgeSeconds: 1_000_000, signatureCount: 20,
      };
    };

    await Promise.all([
      runPayerVerificationBatch({
        database: databaseFor(first) as never,
        inspectPayerWallet: inspect('ConcurrentFunderA66666666666666666666666666666'),
      }),
      runPayerVerificationBatch({
        database: databaseFor(second) as never,
        inspectPayerWallet: inspect('ConcurrentFunderB66666666666666666666666666666'),
      }),
    ]);

    const verified = [first, second].filter((row) => row.payer_verification === 'verified');
    const rejected = [first, second].filter((row) => row.payer_verification === 'rejected');
    expect(verified).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].verification_reason).toBe('first_funder_mapping_conflict');
    expect(h.mappings.get(`devnet|${payer}`)).toBe(requireFirstFunder(verified[0]));
    expect(h.counters.size).toBe(1);
  });
});
