import { beforeEach, afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { isSpendPolicyRaise } from '@clawville/shared';
import type { VendorSpendRow } from '@clawville/database';

const realDatabase = await import('@clawville/database');
const queries: SQL[] = [];
let selectQueue: unknown[][] = [];
let executeQueue: unknown[][] = [];
let inserts: unknown[] = [];
let updates: { where?: SQL; values?: Record<string, unknown> }[] = [];
function chain(rows: unknown[], capture?: (value: unknown) => void): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(rows);
        return (...args: unknown[]) => {
          if (prop === 'values') capture?.(args[0]);
          return proxy;
        };
      },
    },
  );
  return proxy;
}
const fakeDb = {
  select: () => chain(selectQueue.shift() ?? []),
  execute: async (query: SQL) => {
    queries.push(query);
    return executeQueue.shift() ?? [];
  },
  update: () => {
    const record: { where?: SQL; values?: Record<string, unknown> } = {};
    updates.push(record);
    const builder = {
      set(values: Record<string, unknown>) {
        record.values = values;
        return builder;
      },
      where(query: SQL) {
        record.where = query;
        return builder;
      },
      returning() {
        return Promise.resolve([]);
      },
      then(resolve: (rows: unknown[]) => void) {
        resolve([]);
      },
    };
    return builder;
  },
  insert: () => chain([{ id: 'ledger' }], (value) => inserts.push(value)),
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeDb),
};
mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));
const service = await import('../usepod-deposit');
const proofService = await import('../spend-policy-proof');
const {
  depositUsepod,
  buildDepositData,
  buildDepositAccounts,
  buildDepositTransaction,
  decodeDepositEvent,
  checkDepositProof,
  reconcileUsepodDeposits,
  FINALIZED_EVIDENCE_MISMATCH,
  usepodCreditSeen,
  USEPOD_PROGRAM_ID,
  USEPOD_USDC_MINT,
  DEPOSIT_EVENT_DISCRIMINATOR,
} = service;
import type { DepositInput, DepositTerms, DepositProof, UsepodDepositDeps } from '../usepod-deposit';
afterAll(() => {
  mock.module('@clawville/database', () => realDatabase);
});
const wallet = Keypair.generate();
const terms: DepositTerms = {
  code: '0123456789abcdef',
  amount: '500000',
  depositor: wallet.publicKey.toBase58(),
  ledgerId: 'ledger',
  baselineMicro: 100,
};
const input: DepositInput = {
  avatarId: 'avatar',
  userId: 'user',
  actor: 'human',
  amountCents: 50,
  idempotencyKey: 'deposit-1',
};
const settings = {
  code: terms.code,
  tokenLast4: 'abcd',
  wallet: terms.depositor,
};
const policy = {
  dailyCapUsdCents: 100,
  perCallCapUsdCents: 50,
  allowedVendors: ['usepod'],
  requireApproval: false,
  updatedAt: null,
};
function eventBytes(patch: Partial<DepositTerms> = {}): Buffer {
  const t = { ...terms, ...patch };
  const b = Buffer.alloc(96);
  DEPOSIT_EVENT_DISCRIMINATOR.copy(b);
  Buffer.from(t.code, 'hex').copy(b, 8);
  b.writeBigUInt64LE(BigInt(t.amount), 16);
  new PublicKey(USEPOD_USDC_MINT).toBuffer().copy(b, 24);
  new PublicKey(t.depositor).toBuffer().copy(b, 56);
  return b;
}
function proof(): DepositProof {
  const tx = buildDepositTransaction(terms, '11111111111111111111111111111111');
  return {
    finalized: true,
    err: null,
    fee: 5000,
    signatures: ['signature'],
    feePayer: terms.depositor,
    instructions: tx.instructions.map((ix) => ({
      programId: ix.programId.toBase58(),
      data: ix.data,
      keys: ix.keys.map((key) => ({ ...key, pubkey: key.pubkey.toBase58() })),
    })),
    logs: [
      `Program ${USEPOD_PROGRAM_ID} invoke [1]`,
      `Program data: ${eventBytes().toString('base64')}`,
      `Program ${USEPOD_PROGRAM_ID} success`,
    ],
  };
}
let history: string[] = [];
let finishes: { status: string; fields: Record<string, unknown> }[] = [];
let persisted: { bytes: Uint8Array; signature: string } | null = null;
function deps(extra: Partial<UsepodDepositDeps> = {}): Partial<UsepodDepositDeps> {
  let balanceReads = 0;
  return {
    policyPrecheck: async () => null,
    replay: async () => null,
    closeUnsigned: async () => true,
    deferReconcile: async () => {},
    settings: async () => settings,
    precheck: async () => null,
    balance: async () => ({
      usdcMicro: balanceReads++ ? 500100 : 100,
      isActive: true,
    }),
    admit: async () => {
      history.push('admit');
      return { ok: true, ledgerId: 'ledger' };
    },
    blockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100,
    }),
    sign: async (_avatar, tx) => {
      history.push('sign');
      expect(tx.instructions).toHaveLength(2);
      return { bytes: new Uint8Array([1, 2, 3]), signature: 'signature' };
    },
    simulate: async () => {
      history.push('simulate');
      return true;
    },
    persist: async (_id, signed) => {
      history.push('persist');
      persisted = signed;
      return true;
    },
    send: async (bytes) => {
      history.push('send');
      expect(bytes).toBe(persisted!.bytes);
    },
    proof: async () => proof(),
    signatureKnown: async () => false,
    blockHeight: async () => 101,
    finish: async (_id, status, fields) => {
      finishes.push({ status, fields });
    },
    sleep: async () => {},
    reconcileRows: async () => [],
    ...extra,
  };
}
beforeEach(() => {
  selectQueue = [];
  executeQueue = [];
  inserts = [];
  updates = [];
  queries.length = 0;
  history = [];
  finishes = [];
  persisted = null;
  proofService._resetSpendProofNoncesForTest();
});
function admissionFixture(patch: Record<string, unknown> = {}, attempts = 0, spent = '0') {
  selectQueue = [
    [],
    [{ ...policy, ...patch }],
    [
      {
        usepodRegistered: true,
        usepodDepositCode: settings.code,
        usepodTokenLast4: settings.tokenLast4,
      },
    ],
  ];
  executeQueue = [[], [{ spent, attempts }]];
}
function actualAdmission(extra: Partial<UsepodDepositDeps> = {}) {
  const d = deps(extra);
  delete d.admit;
  return d;
}

describe('deposit builders and finalized proof', () => {
  test('IDL data layout and account order', () => {
    const data = buildDepositData(terms.code, 500000n);
    expect(data.length).toBe(24);
    expect(data.subarray(8, 16).toString('hex')).toBe(terms.code);
    expect(data.readBigUInt64LE(16)).toBe(500000n);
    const keys = buildDepositAccounts(terms.depositor);
    expect(keys.map((k) => k.isSigner)).toEqual([false, false, false, true, false, false, false]);
    expect(keys[4]!.pubkey.toBase58()).toBe(USEPOD_USDC_MINT);
  });
  test('invalid code/amount rejected', () => {
    for (const code of ['abcd', 'ABCDEFGHIJKLMNOP', '0123456789ABCDEf'])
      expect(() => buildDepositData(code, 1n)).toThrow();
    expect(() => buildDepositData(terms.code, 0n)).toThrow();
  });
  test('event decoder exact layout', () => {
    expect(decodeDepositEvent(eventBytes())).toMatchObject({
      code: terms.code,
      amount: 500000n,
      mint: USEPOD_USDC_MINT,
      depositor: terms.depositor,
    });
    expect(decodeDepositEvent(eventBytes().subarray(1))).toBeNull();
  });
  test('valid proof and unique memo per ledger', () => {
    expect(checkDepositProof(proof(), terms, 'signature')).toBe(true);
    expect(
      buildDepositTransaction({ ...terms, ledgerId: 'other' }, '11111111111111111111111111111111').serializeMessage(),
    ).not.toEqual(buildDepositTransaction(terms, '11111111111111111111111111111111').serializeMessage());
  });
  test('wrong code, amount, mint, signer, extra instruction, missing memo, finality refused', () => {
    for (const change of [
      (p: DepositProof) => {
        p.finalized = false;
      },
      (p: DepositProof) => {
        p.instructions.pop();
      },
      (p: DepositProof) => {
        p.instructions.push(p.instructions[1]!);
      },
      (p: DepositProof) => {
        p.instructions[0]!.data = buildDepositData('1123456789abcdef', 500000n);
      },
      (p: DepositProof) => {
        p.instructions[0]!.data = buildDepositData(terms.code, 500001n);
      },
      (p: DepositProof) => {
        p.instructions[0]!.keys[4]!.pubkey = terms.depositor;
      },
      (p: DepositProof) => {
        p.instructions[0]!.keys[3]!.isSigner = false;
      },
      (p: DepositProof) => {
        p.logs[1] = `Program data: ${eventBytes({ amount: '600000' }).toString('base64')}`;
      },
      (p: DepositProof) => {
        p.logs.splice(1, 0, 'Program 11111111111111111111111111111111 invoke [2]');
      },
      (p: DepositProof) => {
        p.feePayer = USEPOD_USDC_MINT;
      },
      (p: DepositProof) => {
        p.signatures = ['wrong'];
      },
    ]) {
      const p = proof();
      change(p);
      expect(checkDepositProof(p, terms, 'signature')).toBe(false);
    }
  });
});
describe('admission under spend lock', () => {
  test('allowed payment reserves row before signing', async () => {
    admissionFixture();
    const result = await depositUsepod(input, actualAdmission());
    expect(result).toMatchObject({
      ok: true,
      status: 'paid',
      creditStatus: 'seen',
    });
    expect(inserts).toHaveLength(1);
    expect(history).toEqual(['sign', 'simulate', 'persist', 'send']);
    const query = new PgDialect().sqlToQuery(queries[0]!);
    expect(query.sql).toContain('pg_advisory_xact_lock');
  });
  test('caps and vendor permission refuse without signing', async () => {
    for (const [patch, spent, code] of [
      [{ allowedVendors: [] }, '0', 'vendor_not_allowed'],
      [{ perCallCapUsdCents: 49 }, '0', 'over_per_call_cap'],
      [{}, '510000', 'over_daily_cap'],
      [{ dailyCapUsdCents: null }, '0', 'spend_rules_not_set'],
    ] as const) {
      admissionFixture(patch, 0, spent);
      const result = await depositUsepod(input, actualAdmission());
      expect(result).toMatchObject({ ok: false, code });
      expect(history).toEqual([]);
    }
  });
  test('five per day includes failed-after-send and pending reservations', async () => {
    admissionFixture({}, 5);
    expect(await depositUsepod(input, actualAdmission())).toMatchObject({
      code: 'deposit_daily_limit',
    });
    const text = new PgDialect().sqlToQuery(queries[1]!).sql;
    expect(text).toContain("failure_reason NOT LIKE 'not_sent_%'");
    expect(text).toContain("status IN ('pending','paid','ambiguous')");
  });
  test('agent approval ON refuses before signing', async () => {
    admissionFixture({ requireApproval: true });
    expect(await depositUsepod({ ...input, actor: 'agent' }, actualAdmission())).toMatchObject({
      code: 'approval_required',
    });
    expect(history).toEqual([]);
  });
  test('human approval ON requires signature', async () => {
    admissionFixture({ requireApproval: true });
    expect(await depositUsepod(input, actualAdmission())).toMatchObject({
      code: 'signature_required',
    });
  });
  test('nonce binds exact terms and is single use inside admission', async () => {
    const kp = nacl.sign.keyPair();
    const walletPubkey = bs58.encode(kp.publicKey);
    const challenge = proofService.issueUsepodDepositChallenge('user', service.approvalTerms(input, settings));
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), kp.secretKey));
    for (const expected of ['paid', 'invalid_wallet_proof']) {
      admissionFixture({ requireApproval: true });
      selectQueue.push([{ wallet: walletPubkey }]);
      const result = await depositUsepod({ ...input, nonce: challenge.nonce, signature }, actualAdmission());
      expect(result).toMatchObject(expected === 'paid' ? { status: 'paid' } : { code: expected });
    }
    expect(challenge.messageToSign).toContain('ClawVille usepod-deposit');
    expect(challenge.messageToSign).toContain(challenge.expiresAt);
  });
  test('duplicate key never signs again', async () => {
    selectQueue = [[{ id: 'original' }]];
    executeQueue = [[]];
    expect(await depositUsepod(input, actualAdmission())).toEqual({
      ok: false,
      code: 'duplicate_request',
      ledgerId: 'original',
    });
    expect(history).toEqual([]);
  });
});
describe('flow boundaries', () => {
  test('prechecks refuse ops change, SOL shortage and USDC shortage before admission', async () => {
    for (const code of ['vendor_pay_to_changed', 'needs_sol_for_fee', 'insufficient_usdc']) {
      expect(await depositUsepod(input, deps({ precheck: async () => code }))).toEqual({ ok: false, code });
      expect(history).toEqual([]);
    }
  });
  test('existing idempotent result returns before balance/precheck/sign', async () => {
    const saved = {
      ok: true as const,
      ledgerId: 'ledger',
      status: 'paid' as const,
      txSignature: 'signature',
      usdCents: 50,
      creditStatus: 'seen' as const,
      balance: null,
    };
    expect(
      await depositUsepod(
        input,
        deps({
          replay: async () => saved,
          precheck: async () => {
            throw new Error('must not read');
          },
        }),
      ),
    ).toEqual(saved);
    expect(history).toEqual([]);
  });
  test('simulation failure is not_sent', async () => {
    expect(await depositUsepod(input, deps({ simulate: async () => false }))).toMatchObject({
      code: 'simulation_failed',
    });
    expect(finishes[0]).toEqual({
      status: 'failed',
      fields: { failureReason: 'not_sent_simulation_failed' },
    });
    expect(history).not.toContain('send');
  });
  test('fence failure never sends', async () => {
    expect(await depositUsepod(input, deps({ persist: async () => false }))).toMatchObject({ code: 'payment_fenced' });
    expect(history).not.toContain('send');
  });
  test('send timeout remains ambiguous', async () => {
    expect(
      await depositUsepod(
        input,
        deps({
          send: async () => {
            throw new Error('timeout');
          },
        }),
      ),
    ).toMatchObject({ status: 'ambiguous', creditStatus: 'unknown' });
    expect(finishes[0]!.status).toBe('ambiguous');
  });
  test('confirmed is ambiguous, finalized error records fee', async () => {
    expect(await depositUsepod(input, deps({ proof: async () => ({ ...proof(), finalized: false }) }))).toMatchObject({
      status: 'ambiguous',
    });
    finishes = [];
    expect(
      await depositUsepod(
        input,
        deps({
          proof: async () => ({ ...proof(), err: { InstructionError: 1 } }),
        }),
      ),
    ).toMatchObject({ status: 'failed' });
    expect(finishes[0]!.fields).toMatchObject({
      feeLamports: 5000,
      failureReason: 'onchain_error_finalized',
    });
  });
  test('credit status reports observed increase only', async () => {
    expect(
      await depositUsepod(input, deps({ balance: async () => ({ usdcMicro: 100, isActive: true }) })),
    ).toMatchObject({ status: 'paid', creditStatus: 'unknown' });
    expect(usepodCreditSeen(100, 500000n, { usdcMicro: 495100, isActive: true })).toBe(true);
    expect(usepodCreditSeen(100, 500000n, { usdcMicro: 495099, isActive: true })).toBe(false);
  });
});
function row(patch: Partial<VendorSpendRow> = {}): VendorSpendRow {
  return {
    id: 'ledger',
    avatarId: 'avatar',
    status: 'ambiguous',
    payerSignature: 'signature',
    depositTerms: terms,
    lastValidBlockHeight: 100,
    createdAt: new Date(Date.now() - 700000),
    creditStatus: 'unknown',
    failureReason: null,
    ...patch,
  } as VendorSpendRow;
}
describe('dedicated reconcile', () => {
  test('finalized valid paid; finalized error failed with fee', async () => {
    for (const error of [null, { InstructionError: 1 }]) {
      finishes = [];
      const decisions = await reconcileUsepodDeposits({
        apply: true,
        deps: deps({
          reconcileRows: async () => [row()],
          proof: async () => ({ ...proof(), err: error }),
        }),
      });
      expect(decisions[0]!.status).toBe(error ? 'failed' : 'paid');
      expect(finishes[0]!.fields.feeLamports).toBe(5000);
    }
  });
  test('unknown expired fails only after finalized height then history lookup', async () => {
    const order: string[] = [];
    const decisions = await reconcileUsepodDeposits({
      apply: true,
      deps: deps({
        reconcileRows: async () => [row()],
        proof: async () => null,
        blockHeight: async () => {
          order.push('height');
          return 101;
        },
        signatureKnown: async () => {
          order.push('history');
          return false;
        },
      }),
    });
    expect(decisions[0]!.status).toBe('failed');
    expect(order).toEqual(['height', 'history']);
  });
  test('finalized success with mismatched evidence stays ambiguous after expiry (Codex 11-09)', async () => {
    finishes = [];
    const decisions = await reconcileUsepodDeposits({
      apply: true,
      deps: deps({
        reconcileRows: async () => [row()],
        proof: async () => ({ ...proof(), logs: [] }),
        blockHeight: async () => 101,
        signatureKnown: async () => false,
      }),
    });
    expect(decisions[0]!.status).toBe('ambiguous');
    expect(finishes[0]!.status).toBe('ambiguous');
    expect(finishes[0]!.fields.failureReason).toBe(FINALIZED_EVIDENCE_MISMATCH);
    expect(history).not.toContain('send');
    // Pass 2 (Codex round 2): the RPC now returns nothing, the blockhash expired,
    // the signature is unknown. The sticky marker keeps the row 'ambiguous'.
    finishes = [];
    const second = await reconcileUsepodDeposits({
      apply: true,
      deps: deps({
        reconcileRows: async () => [row({ status: 'ambiguous', failureReason: FINALIZED_EVIDENCE_MISMATCH })],
        proof: async () => null,
        blockHeight: async () => 101,
        signatureKnown: async () => false,
      }),
    });
    expect(second[0]!.status).toBe('ambiguous');
    expect(finishes[0]!.status).toBe('ambiguous');
    expect(finishes[0]!.fields.failureReason).toBe(FINALIZED_EVIDENCE_MISMATCH);
  });
  test('known or unexpired remains ambiguous and never sends', async () => {
    for (const [height, known] of [
      [100, false],
      [101, true],
    ] as const) {
      const decisions = await reconcileUsepodDeposits({
        apply: true,
        deps: deps({
          reconcileRows: async () => [row()],
          proof: async () => null,
          blockHeight: async () => height,
          signatureKnown: async () => known,
        }),
      });
      expect(decisions[0]!.status).toBe('ambiguous');
      expect(history).not.toContain('send');
    }
  });
  test('paid unknown older than ten minutes reports operator review, never repays', async () => {
    const decisions = await reconcileUsepodDeposits({
      apply: true,
      deps: deps({
        reconcileRows: async () => [{ ...row(), status: 'paid' }],
        balance: async () => ({ usdcMicro: 100, isActive: true }),
      }),
    });
    expect(decisions[0]).toMatchObject({
      status: 'paid',
      creditStatus: 'unknown',
      operatorReview: true,
    });
    expect(history).not.toContain('send');
  });
});

describe('final admission fence and policy raise', () => {
  test('adding usepod requires the existing permission raise signature', () => {
    const current = {
      dailyCapUsdCents: 100,
      perCallCapUsdCents: 50,
      allowedVendors: ['studios'],
      studiosKeyImagesPerDay: 10,
      studiosVideosPerDay: 2,
      studiosCharacterShotsPerDay: 5,
      studiosRecastsPerDay: 1,
      requireApproval: false,
      studiosPayMode: null,
    };
    expect(isSpendPolicyRaise(current, { ...current, allowedVendors: ['studios', 'usepod'] })).toBe(true);
  });
  test('agent approved under old rules is fenced when ask-before becomes ON', async () => {
    const d = deps();
    delete d.persist;
    selectQueue = [[{ ...policy, requireApproval: true }], [{ usepodRegistered: true, usepodDepositCode: terms.code }]];
    executeQueue = [[], [{ total: '500000' }]];
    expect(await depositUsepod({ ...input, actor: 'agent' }, d)).toMatchObject({ code: 'payment_fenced' });
    expect(history).not.toContain('send');
    expect(new PgDialect().sqlToQuery(queries[0]!).sql).toContain('pg_advisory_xact_lock');
  });
  test('destination changed before signature persistence is fenced', async () => {
    const d = deps();
    delete d.persist;
    selectQueue = [[policy], [{ usepodRegistered: true, usepodDepositCode: 'ffffffffffffffff' }]];
    executeQueue = [[], [{ total: '500000' }]];
    expect(await depositUsepod(input, d)).toMatchObject({ code: 'payment_fenced' });
    expect(history).not.toContain('send');
  });
  test('unsigned interruption cleanup uses its injected conditional writer', async () => {
    const closed: string[] = [];
    const decisions = await reconcileUsepodDeposits({
      apply: true,
      deps: deps({
        reconcileRows: async () => [{ ...row(), status: 'pending', payerSignature: null }],
        closeUnsigned: async (id) => {
          closed.push(id);
          return true;
        },
      }),
    });
    expect(closed).toEqual(['ledger']);
    expect(decisions[0]!.status).toBe('failed');
  });
  test('event code and mint must match independently of instruction', () => {
    for (const bytes of [eventBytes({ code: 'ffffffffffffffff' }), eventBytes()]) {
      if (bytes.subarray(8, 16).toString('hex') === terms.code) wallet.publicKey.toBuffer().copy(bytes, 24);
      const p = proof();
      p.logs[1] = `Program data: ${bytes.toString('base64')}`;
      expect(checkDepositProof(p, terms, 'signature')).toBe(false);
    }
  });
});

describe('database persistence guards', () => {
  test('final persistence fences a previous UTC day and an already resolved row', async () => {
    const d = deps();
    delete d.persist;
    selectQueue = [[policy], [{ usepodRegistered: true, usepodDepositCode: terms.code }]];
    executeQueue = [[], [{ total: '500000' }]];
    expect(await depositUsepod(input, d)).toMatchObject({ code: 'payment_fenced' });
    const query = new PgDialect().sqlToQuery(updates[0]!.where!);
    expect(query.sql).toContain("date_trunc('day'");
    expect(query.sql).toContain('payer_signature');
    expect(query.params).toContain('pending');
    expect(history).not.toContain('send');
  });
  test('ambiguous finish cannot overwrite paid, and seen credit is sticky', async () => {
    const d = deps({
      send: async () => {
        throw new Error('timeout');
      },
    });
    delete d.finish;
    await depositUsepod(input, d);
    const query = new PgDialect().sqlToQuery(updates[0]!.where!);
    expect(query.params).toContain('pending');
    expect(query.params).toContain('ambiguous');
    expect(query.params).not.toContain('paid');
    updates = [];
    const paidDeps = deps();
    delete paidDeps.finish;
    await depositUsepod(input, paidDeps);
    const credit = updates.at(-1)!.values!.creditStatus as SQL;
    expect(new PgDialect().sqlToQuery(credit).sql).toContain("WHEN credit_status = 'seen' THEN 'seen'");
  });
  test('a stale ambiguous writer cannot erase the mismatch marker, and failed never applies to a marked row', async () => {
    // Stale reconciler: saw no proof, writes ambiguous with failureReason null.
    const d = deps({ reconcileRows: async () => [row()], proof: async () => null, blockHeight: async () => 100 });
    delete d.finish;
    updates = [];
    await reconcileUsepodDeposits({ apply: true, deps: d });
    const reason = new PgDialect().sqlToQuery(updates[0]!.values!.failureReason as SQL);
    expect(reason.sql).toContain('CASE WHEN failure_reason =');
    expect(reason.params).toContain(FINALIZED_EVIDENCE_MISMATCH);
    // An expiry write to 'failed' carries the SQL guard on the marker.
    const e = deps({ reconcileRows: async () => [row()], proof: async () => null, blockHeight: async () => 101, signatureKnown: async () => false });
    delete e.finish;
    updates = [];
    await reconcileUsepodDeposits({ apply: true, deps: e });
    const where = new PgDialect().sqlToQuery(updates[0]!.where!);
    expect(updates[0]!.values!.status).toBe('failed');
    expect(where.sql).toContain('IS DISTINCT FROM');
    expect(where.params).toContain(FINALIZED_EVIDENCE_MISMATCH);
  });
});

describe('bounded credit recovery', () => {
  test('already paid rows never fetch chain proof, and unknown credit schedules another check', async () => {
    let scheduled = 0;
    const decisions = await reconcileUsepodDeposits({
      apply: true,
      deps: deps({
        reconcileRows: async () => [{ ...row(), status: 'paid', reconcileAttempts: 2 }],
        proof: async () => {
          throw new Error('immutable proof must not be fetched');
        },
        balance: async () => ({ usdcMicro: 100, isActive: true }),
        deferReconcile: async () => {
          scheduled++;
        },
      }),
    });
    expect(decisions[0]).toMatchObject({ status: 'paid', creditStatus: 'unknown', operatorReview: true });
    expect(scheduled).toBe(1);
  });
  test('eight automatic checks stop, explicit operator override can observe credit', async () => {
    let reads = 0;
    const override = deps({
      reconcileRows: async () => [{ ...row(), status: 'paid', reconcileAttempts: 8 }],
      balance: async () => {
        reads++;
        return { usdcMicro: 500100, isActive: true };
      },
      proof: async () => {
        throw new Error('no proof refetch');
      },
    });
    expect((await reconcileUsepodDeposits({ apply: true, deps: override }))[0]).toMatchObject({
      status: 'paid',
      creditStatus: 'unknown',
      operatorReview: true,
    });
    expect(reads).toBe(0);
    expect((await reconcileUsepodDeposits({ apply: true, includeExhausted: true, deps: override }))[0]).toMatchObject({
      status: 'paid',
      creditStatus: 'seen',
    });
    expect(reads).toBe(1);
  });
  test('retry storage increments attempts with capped exponential delay', async () => {
    const d = deps({
      reconcileRows: async () => [{ ...row(), status: 'paid' }],
      balance: async () => ({ usdcMicro: 100, isActive: true }),
    });
    delete d.deferReconcile;
    await reconcileUsepodDeposits({ apply: true, deps: d });
    const values = updates.at(-1)!.values!;
    expect(new PgDialect().sqlToQuery(values.reconcileAttempts as SQL).sql).toContain('+ 1');
    expect(new PgDialect().sqlToQuery(values.reconcileNextAt as SQL).sql).toContain('1440');
  });
  test('cheap agent approval preflight refuses before any external read', async () => {
    const d = deps({
      precheck: async () => {
        throw new Error('RPC must not run');
      },
      balance: async () => {
        throw new Error('provider must not run');
      },
    });
    delete d.policyPrecheck;
    selectQueue = [[{ ...policy, requireApproval: true }]];
    expect(await depositUsepod({ ...input, actor: 'agent' }, d)).toEqual({ ok: false, code: 'approval_required' });
    expect(history).toEqual([]);
  });
});

test('credit response clears its deadline timer', async () => {
  const clear = spyOn(globalThis, 'clearTimeout');
  try {
    await depositUsepod(input, deps());
    expect(clear).toHaveBeenCalled();
  } finally { clear.mockRestore(); }
});

const { OwnAiError } = await import('../own-ai');
describe('first deposit on a token UsePod has not activated', () => {
  const notActivatedThenFunded = () => {
    let reads = 0;
    return async () => {
      if (reads++ === 0) throw new OwnAiError('usepod_not_activated');
      return { usdcMicro: 500000, isActive: true };
    };
  };
  test('no prior deposit: baseline 0, deposit runs, credit seen', async () => {
    let flag: boolean | undefined;
    const r = await depositUsepod(
      input,
      deps({
        balance: notActivatedThenFunded(),
        priorDeposit: async () => false,
        admit: async (_i, _s, firstDeposit) => {
          flag = firstDeposit;
          history.push('admit');
          return { ok: true, ledgerId: 'ledger' };
        },
      }),
    );
    expect(r).toMatchObject({ ok: true, status: 'paid', creditStatus: 'seen' });
    expect(flag).toBe(true);
    expect(history).toContain('send');
  });
  test('a normal balance read passes firstDeposit false to admission', async () => {
    let flag: boolean | undefined;
    await depositUsepod(
      input,
      deps({ admit: async (_i, _s, firstDeposit) => { flag = firstDeposit; return { ok: true, ledgerId: 'ledger' }; } }),
    );
    expect(flag).toBe(false);
  });
  test('real admission: a concurrent first deposit already holds a row -> refused under the lock', async () => {
    selectQueue = [[], [{ id: 'other-ledger' }]];
    const r = await depositUsepod(input, actualAdmission({ balance: notActivatedThenFunded(), priorDeposit: async () => false }));
    expect(r).toEqual({ ok: false, code: 'provider_error' });
    expect(inserts).toEqual([]);
    expect(history).toEqual([]);
  });
  test('real admission: no prior row -> admitted and paid', async () => {
    admissionFixture();
    selectQueue.splice(1, 0, []);
    const r = await depositUsepod(input, actualAdmission({ balance: notActivatedThenFunded(), priorDeposit: async () => false }));
    expect(r).toMatchObject({ ok: true, status: 'paid', creditStatus: 'seen' });
    expect(inserts).toHaveLength(1);
  });
  test('priorDeposit lookup failure refuses before admission', async () => {
    const r = await depositUsepod(
      input,
      deps({ balance: notActivatedThenFunded(), priorDeposit: async () => { throw new Error('db down'); } }),
    );
    expect(r).toEqual({ ok: false, code: 'provider_error' });
    expect(history).toEqual([]);
  });
  test('hasPriorUsepodDeposit filters avatar, vendor usepod and money-moving statuses', async () => {
    const seen: unknown[] = [];
    const exec = {
      select: () => {
        const p: unknown = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') return (res: (v: unknown) => void) => res([]);
            return (...args: unknown[]) => { if (prop === 'where') seen.push(args[0]); return p; };
          },
        });
        return p;
      },
    };
    expect(await service.hasPriorUsepodDeposit(exec as never, 'avatar')).toBe(false);
    const q = new PgDialect().sqlToQuery(seen[0] as SQL);
    expect(q.sql).toContain(`IN ('pending','ambiguous','paid')`);
    expect(q.params).toEqual(['avatar', 'usepod']);
  });
  test('a prior deposit exists: refused before admission', async () => {
    const r = await depositUsepod(input, deps({ balance: notActivatedThenFunded(), priorDeposit: async () => true }));
    expect(r).toEqual({ ok: false, code: 'provider_error' });
    expect(history).toEqual([]);
  });
  test('a plain key_rejected (pasted token) still refuses', async () => {
    const r = await depositUsepod(
      input,
      deps({ balance: async () => { throw new OwnAiError('key_rejected'); }, priorDeposit: async () => false }),
    );
    expect(r).toEqual({ ok: false, code: 'provider_error' });
    expect(history).toEqual([]);
  });
});
