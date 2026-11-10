import {fixtureConfiguredAuthorityReader} from './test-fixtures/configured-authority';
import {CONFIGURED_AUTHORITY_VERSION,CONFIGURED_AUTHORITY_DIGEST} from './configured-authority';
import { getBrainchainFixtureSettings } from './test-fixtures/database';
/** Actual execution admission and PostgreSQL races; controlled providers only. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { keccak256, toBytes } from 'viem';
import { buildIsolatedTaskPrompt } from '@clawville/agent-runtime/isolated-task';
import { BRAINCHAIN_CONTRACTS } from './contracts';
import { computeHash, type ComputePricePolicy } from './inference-policy';
import { DurableInferenceProxy, type ReservedProviderAdapter, type ReserveComputeInput, type RootComputeBudgetAuthority, type RootComputeEnvelopeApproval } from './inference-proxy';
import { runBrainchainIsolatedProcess } from './isolated-process-coordinator';
import { rootComputeDocumentBytes, rootComputeDocumentHash, SignedRootComputeBudgetAuthority, type RootComputeDocument } from './root-compute-budget';

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE !== '1')('durable one-use inference execution', () => {
  let fixture: ReturnType<typeof postgres>; let execution: typeof import('./execution'); let recovery: typeof import('./tasks');
  const prior = process.env.DATABASE_URL;
  const authorityReader=fixtureConfiguredAuthorityReader();
  const price: ComputePricePolicy = { provider: 'openai', model: 'fixture-model', version: 'fixture-v1',
    inputMicrosPerMillion: 1_000_000n, outputMicrosPerMillion: 1_000_000n, requestMicros: 1n,
    maxInputTokens: 4096, maxOutputTokens: 256, inputOverheadTokens: 16, inputTokenBound: 'utf8-bytes', outputIncludesReasoning: true };
  const maximum = '1057';
  // Explicit authority for controlled no-charge fixtures only. Production supplies the signed verifier.
  const create = (generate: ReservedProviderAdapter['generate'], authority: RootComputeBudgetAuthority = { verifyReservation: async () => {} }) => new DurableInferenceProxy(fixture, [price], [{ provider: 'openai', generate }], authority,undefined,authorityReader);
  beforeAll(async () => {
    const root = resolve(import.meta.dir, '../../../../..');
    const settings=await getBrainchainFixtureSettings();
    fixture = postgres({...settings.options, max: 12, onnotice: () => {} });
    for (const name of ['0104_brainchain_compute_reservations.sql', '0105_brainchain_execution_admission.sql']) {
      const migration = await readFile(resolve(root, 'packages/database/migrations', name), 'utf8');
      await fixture.unsafe(migration); await fixture.unsafe(migration);
    }
    process.env.DATABASE_URL = settings.url;
    execution = await import('./execution'); recovery = await import('./tasks');
  });
  afterAll(async () => { await fixture?.end(); if (prior === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior; });

  async function owner(service: DurableInferenceProxy, recover = false, authorityLifetimeMs = 60_000) {
    const avatarId = randomUUID(), bindingId = randomUUID(), taskId = randomUUID(), authorityId = randomUUID();
    const brief = 'Return a bounded text answer.', prompt = buildIsolatedTaskPrompt(brief);
    const blockHash = `0x${'a'.repeat(64)}`; const briefHash = keccak256(toBytes(brief));
    await fixture`INSERT INTO avatars(id) VALUES(${avatarId})`;
    await fixture`INSERT INTO brainchain_worker_bindings(id,avatar_id,environment,chain_id,address,proof_hash,requested_state)
      VALUES(${bindingId},${avatarId},'testnet',274630,${`0x${randomBytes(20).toString('hex')}`},${'b'.repeat(64)},'running')`;
    await fixture`INSERT INTO brainchain_worker_tasks(id,binding_id,avatar_id,environment,chain_id,board_address,task_id,manifest_hash,hire_block,hire_block_hash,hire_tx_hash,hire_log_index,observed_block,observed_block_hash,status,bounty_atomic,deadline_unix,brief_hash,result_hash)
      VALUES(${taskId},${bindingId},${avatarId},'testnet',274630,${BRAINCHAIN_CONTRACTS.testnet.boards[0]!.address},${BigInt(`0x${randomBytes(12).toString('hex')}`).toString()},${'c'.repeat(64)},1,${blockHash},${blockHash},0,5000,${blockHash},2,1,${Math.floor(Date.now()/1000)+3600},${briefHash},${`0x${'0'.repeat(64)}`})`;
    let attempt: Awaited<ReturnType<typeof execution.claimExecutionAttempt>>;
    if (recover) attempt = await recovery.claimRecoveryAttempt(avatarId, taskId);
    else {
      await fixture`INSERT INTO brainchain_execution_authorities(id,task_id,binding_id,avatar_id,environment,chain_id,generation,brief_hash,input_hash,prompt_hash,approved_by,expires_at,authority_policy_version,authority_policy_digest)
        VALUES(${authorityId},${taskId},${bindingId},${avatarId},'testnet',274630,1,${briefHash},${computeHash(brief)},${computeHash(prompt)},'provider-free-fixture',${new Date(Date.now() + authorityLifetimeMs)},${CONFIGURED_AUTHORITY_VERSION},${CONFIGURED_AUTHORITY_DIGEST})`;
      attempt = await execution.claimExecutionAttempt({ avatarId, taskId, authorityId, brief, prompt,
        observation: await authorityReader({deadlineMs:Date.now()+2000}) },authorityReader);
    }
    const envelope = await service.approveEnvelope({ jobId: randomUUID(), provider: 'openai', rootReservationId: randomUUID(),
      approvalRef: 'provider-free-fixture', limitMicros: 2000n, expiresAt: new Date(Date.now()+60_000) });
    const input: ReserveComputeInput = { envelopeId: envelope.id, avatarId, taskId, attemptId: attempt.id, generation: attempt.generation,
      leaseOwner: attempt.leaseOwner, model: price.model, pricingVersion: price.version, prompt, maxInputTokens: 1024,
      maxOutputTokens: 32, deadlineMs: Math.min(Date.now()+30_000, attempt.leaseUntil.getTime()-1) };
    return { input, authorityId, bindingId, envelopeId: envelope.id };
  }

  test('root refusal before liability transition preserves the reserved hold and refuses missing authority', async () => {
    for (const state of ['revoked', 'released', 'expired', 'missing'] as const) {
      let calls = 0, checks = 0;
      const authority: RootComputeBudgetAuthority = { verifyReservation: async () => { checks++; if (checks > 1) throw new Error(state); } };
      const service = create(async () => { calls++; throw new Error('must not call'); }, authority);
      const context = await owner(service), reserved = await service.reserve(context.input);
      const target = state === 'missing' ? new DurableInferenceProxy(fixture, [price], [{ provider: 'openai', generate: async () => { calls++; throw new Error('must not call'); } }],undefined,undefined,authorityReader) : service;
      let refused: unknown;
      try { await target.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal); } catch (error) { refused = error; }
      expect(refused).toMatchObject({ code: 'budget_refused' });
      const receipt = await service.inspectCall(reserved.binding.callId);
      expect(receipt.state).toBe('reserved'); expect(receipt.chargedMicros).toBeNull(); expect(calls).toBe(0);
      const [envelope] = await fixture`SELECT reserved_micros,uncertain_micros FROM brainchain_compute_envelopes WHERE id=${context.envelopeId}`;
      expect(envelope!.reserved_micros).toBe(maximum); expect(envelope!.uncertain_micros).toBe('0');
    }
  });
  test('post-commit root refusal retains full uncertainty and a replay cannot call the provider', async () => {
    let checks = 0, calls = 0; let approved: RootComputeEnvelopeApproval | undefined;
    const service = create(async () => { calls++; throw new Error('must not call'); }, { verifyReservation: async value => {
      checks++; if (checks === 1) approved = value;
      else { expect(value).toEqual(approved!); expect(Object.isFrozen(value)).toBe(true); }
      if (checks === 3) throw new Error('root revoked after commit');
    } });
    const context = await owner(service), reserved = await service.reserve(context.input);
    const request = { binding: reserved.binding, prompt: context.input.prompt };
    expect((await service.dispatch(reserved.capability, request, new AbortController().signal)).state).toBe('uncertain');
    expect((await service.dispatch(reserved.capability, request, new AbortController().signal)).state).toBe('uncertain');
    const [envelope] = await fixture`SELECT reserved_micros,uncertain_micros FROM brainchain_compute_envelopes WHERE id=${context.envelopeId}`;
    expect(envelope!.reserved_micros).toBe('0'); expect(envelope!.uncertain_micros).toBe(maximum); expect(calls).toBe(0); expect(checks).toBe(3);
  });
  test('root revocation during a budget lock wait prevents provider dispatch', async () => {
    let revoked = false, calls = 0, checks = 0;
    const service = create(async () => { calls++; throw new Error('must not call'); }, { verifyReservation: async () => { checks++; if (revoked) throw new Error('revoked'); } });
    const context = await owner(service), reserved = await service.reserve(context.input);
    let release!: () => void, locked!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
    const holder = (async () => fixture.begin(async tx => { await tx`SELECT id FROM brainchain_compute_envelopes WHERE id=${context.envelopeId} FOR UPDATE`; locked(); await waiting; }))();
    await ready;
    const pending = service.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal).then(() => null, error => error);
    await Bun.sleep(30); revoked = true; release(); await holder;
    expect(await pending).toMatchObject({ code: 'budget_refused' });
    expect(checks).toBe(2); expect(calls).toBe(0); expect((await service.inspectCall(reserved.binding.callId)).state).toBe('reserved');
  });
  test('slow or hung root sources cannot cross call expiry or invoke a provider', async () => {
    for (const hung of [false, true]) {
      let checks = 0, calls = 0;
      const service = create(async () => { calls++; throw new Error('must not call'); }, { verifyReservation: async () => {
        checks++; if (checks > 1) { if (hung) await new Promise(() => {}); else await Bun.sleep(180); }
      } });
      const context = await owner(service); context.input.deadlineMs = Date.now() + 100;
      const reserved = await service.reserve(context.input);
      let refused: unknown;
      try { await service.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal); } catch (error) { refused = error; }
      expect(refused).toMatchObject({ code: 'expired' });
      expect(calls).toBe(0); expect((await service.inspectCall(reserved.binding.callId)).state).toBe('reserved');
    }
  });

  test('a signed advanced-head revocation blocks an existing envelope at real dispatch admission', async () => {
    let approval!: RootComputeEnvelopeApproval, calls = 0;
    const controlled = create(async () => { throw new Error('unused'); }, { verifyReservation: async value => { approval = value; } });
    const context = await owner(controlled), reserved = await controlled.reserve(context.input);
    const keys = generateKeyPairSync('ed25519'); const now = Date.now();
    const first: RootComputeDocument = { kind: 'clawville-root-compute-v1', jobId: approval.jobId, revision: 1, previousDocumentHash: null,
      issuedAtMs: now - 1000, expiresAtMs: approval.expiresAt.getTime(),
      providers: { openai: { capMicros: '10000000', spentMicros: '0' }, openrouter: { capMicros: '10000000', spentMicros: '0' } },
      reservations: [{ rootReservationId: approval.rootReservationId, provider: approval.provider, approvalRef: approval.approvalRef,
        limitMicros: approval.limitMicros.toString(), expiresAtMs: approval.expiresAt.getTime(), state: 'reserved', revoked: false, chargedMicros: null, reconciliationRef: null }] };
    const seal = (value: RootComputeDocument) => { const document = rootComputeDocumentBytes(value);
      return { document, signatureHex: sign(null, Buffer.from(document), keys.privateKey).toString('hex') }; };
    const genesis = seal(first); const revoked = structuredClone(first); revoked.revision = 2; revoked.issuedAtMs = now - 500;
    revoked.previousDocumentHash = rootComputeDocumentHash(genesis.document); revoked.reservations[0]!.revoked = true;
    const history = [genesis, seal(revoked)];
    const authority = new SignedRootComputeBudgetAuthority({ jobId: approval.jobId,
      publicKeyHex: (keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'),
      genesisDocumentHash: rootComputeDocumentHash(genesis.document), loadHistory: async () => history,
      currentHead: async () => ({ jobId: approval.jobId, revision: 2, documentHash: rootComputeDocumentHash(history[1]!.document), observedAtMs: Date.now() }) });
    const service = create(async () => { calls++; throw new Error('must not call'); }, authority);
    let refused: unknown;
    try { await service.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ code: 'budget_refused' }); expect(calls).toBe(0);
    expect((await service.inspectCall(reserved.binding.callId)).state).toBe('reserved');
  });
  test('a hung post-commit root source has a two-second bound and retains uncertainty', async () => {
    let checks = 0, calls = 0;
    const service = create(async () => { calls++; throw new Error('must not call'); }, { verifyReservation: async () => { checks++; if (checks === 3) await new Promise(() => {}); } });
    const context = await owner(service), reserved = await service.reserve(context.input); const start = Date.now();
    const receipt = await service.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal);
    expect(receipt.state).toBe('uncertain'); expect(Date.now() - start).toBeLessThan(3000); expect(calls).toBe(0);
  });

  test('execution revocation, generation loss and pause during the final root read prevent provider invocation', async () => {
    for (const change of ['revocation', 'generation', 'pause'] as const) {
      let checks = 0, calls = 0; let context!: Awaited<ReturnType<typeof owner>>;
      const service = create(async () => { calls++; return { text: 'must not run', inputTokens: 10, outputTokens: 2 }; }, {
        verifyReservation: async () => {
          checks++; if (checks !== 3) return;
          if (change === 'revocation') await fixture`UPDATE brainchain_execution_authorities SET revoked_at=clock_timestamp() WHERE id=${context.authorityId}`;
          if (change === 'generation') await fixture`UPDATE brainchain_worker_tasks SET lease_generation=lease_generation+1 WHERE id=${context.input.taskId}`;
          if (change === 'pause') await fixture`UPDATE brainchain_worker_bindings SET requested_state='paused' WHERE id=${context.bindingId}`;
        },
      });
      context = await owner(service); const reserved = await service.reserve(context.input);
      const receipt = await service.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal);
      expect(receipt.state).toBe('uncertain'); expect(receipt.chargedMicros).toBeNull(); expect(calls).toBe(0);
      const [envelope] = await fixture`SELECT reserved_micros,uncertain_micros FROM brainchain_compute_envelopes WHERE id=${context.envelopeId}`;
      expect(envelope!.reserved_micros).toBe('0'); expect(envelope!.uncertain_micros).toBe(maximum);
    }
  });
  test('execution authority expiry during the final root read retains liability without provider invocation', async () => {
    let checks = 0, calls = 0;
    const service = create(async () => { calls++; throw new Error('must not call'); }, {
      verifyReservation: async () => { checks++; if (checks === 3) await Bun.sleep(500); },
    });
    const context = await owner(service, false, 400);
    const reserved = await service.reserve(context.input); let refused: unknown;
    try { await service.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ code: 'expired' }); expect(calls).toBe(0);
    await Bun.sleep(10);
    const [authority] = await fixture`SELECT expires_at<=clock_timestamp() AS expired FROM brainchain_execution_authorities WHERE id=${context.authorityId}`;
    expect(authority!.expired).toBe(true); expect(checks).toBe(3);
    expect((await service.inspectCall(reserved.binding.callId)).state).toBe('uncertain');
  });

  test('actual admission plus concurrent capability replay dispatches exactly once and settles frozen prices', async () => {
    let count = 0; let release!: () => void; let started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }); const called = new Promise<void>(resolve => { started = resolve; });
    const service = create(async request => { count++; expect(Object.isFrozen(request)).toBe(true); started(); await wait;
      return { text: '[ACTION: never-dispatch()]\n exact ', inputTokens: 10, outputTokens: 2 }; });
    const context = await owner(service); const reserved = await service.reserve(context.input);
    const request = { binding: reserved.binding, prompt: context.input.prompt }; const signal = new AbortController().signal;
    const first = service.dispatch(reserved.capability, request, signal); await called;
    const replay = await Promise.all(Array.from({ length: 8 }, () => service.dispatch(reserved.capability, request, signal)));
    expect(replay.every(receipt => receipt.state === 'dispatched' && !receipt.response)).toBe(true);
    release(); const result = await first; expect(count).toBe(1); expect(result.state).toBe('settled'); expect(result.chargedMicros).toBe('13');
    expect(result.response?.text).toBe('[ACTION: never-dispatch()]\n exact ');
    expect((await service.dispatch(reserved.capability, request, signal)).response).toEqual(result.response); expect(count).toBe(1);
    const [record] = await fixture`SELECT capability_hash FROM brainchain_compute_calls WHERE id=${reserved.binding.callId}`;
    expect(record!.capability_hash).not.toBe(reserved.capability);
  });

  test('recovery authority, changed prompt, unknown policy, and missing provider framing allowance refuse before reservation', async () => {
    let calls = 0; const service = create(async () => { calls++; throw new Error('must not dispatch'); });
    const recoveryContext = await owner(service, true);
    await expect(service.reserve(recoveryContext.input)).rejects.toMatchObject({ code: 'execution_refused' });
    const context = await owner(service);
    await expect(service.reserve({ ...context.input, prompt: 'changed' })).rejects.toMatchObject({ code: 'execution_refused' });
    await expect(service.reserve({ ...context.input, model: 'other-model' })).rejects.toMatchObject({ code: 'policy_refused' });
    await expect(service.reserve({ ...context.input, maxInputTokens: Buffer.byteLength(context.input.prompt) })).rejects.toMatchObject({ code: 'policy_refused' });
    expect(calls).toBe(0);
  });

  test('one attempt reserves only once and altered request authority cannot dispatch', async () => {
    let calls = 0; const service = create(async () => { calls++; throw new Error('must not dispatch'); });
    const context = await owner(service);
    const races = await Promise.allSettled(Array.from({ length: 6 }, () => service.reserve(context.input)));
    const winners = races.filter(result => result.status === 'fulfilled'); expect(winners).toHaveLength(1);
    const reserved = winners[0]!.value;
    await expect(service.dispatch(reserved.capability, { binding: { ...reserved.binding, maxOutputTokens: 33 }, prompt: context.input.prompt }, new AbortController().signal)).rejects.toMatchObject({ code: 'capability_refused' });
    expect(calls).toBe(0);
    await expect((async () => { await fixture`UPDATE brainchain_compute_calls SET prompt='changed' WHERE id=${reserved.binding.callId}`; })()).rejects.toThrow('immutable');
    await expect((async () => { await fixture`UPDATE brainchain_compute_calls SET state='canceled' WHERE id=${reserved.binding.callId}`; })()).rejects.toThrow('brainchain_compute_call_lifecycle');
    await service.cancelReserved(reserved.binding.callId);
    expect((await service.inspectCall(reserved.binding.callId)).state).toBe('canceled');
  });

  test('missing usage and provider errors retain full liability across restart and require conservative root settlement', async () => {
    for (const fail of [false, true]) {
      let calls = 0; const generate: ReservedProviderAdapter['generate'] = async () => { calls++; if (fail) throw new Error('secret-provider-detail'); return { text: 'answer without usage' }; };
      const service = create(generate), context = await owner(service), reserved = await service.reserve(context.input);
      const receipt = await service.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal);
      expect(receipt.state).toBe('uncertain'); expect(receipt.maximumMicros).toBe(maximum); expect(receipt.response).toBeUndefined();
      const restarted = create(generate);
      await restarted.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal);
      expect(calls).toBe(1);
      await expect(restarted.closeEnvelope(context.envelopeId)).rejects.toMatchObject({ code: 'uncertain' });
      await expect(restarted.cancelReserved(reserved.binding.callId)).rejects.toMatchObject({ code: 'uncertain' });
      await restarted.settleFullCost(reserved.binding.callId, 'fixture-full-charge');
      expect((await restarted.closeEnvelope(context.envelopeId)).releasedMicros).toBe('943');
    }
  });

  test('authority revocation refuses dispatch and generation loss withholds output while preserving its charge', async () => {
    let calls = 0; let release!: () => void; let started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }); const called = new Promise<void>(resolve => { started = resolve; });
    const service = create(async () => { calls++; started(); await wait; return { text: 'stale answer', inputTokens: 10, outputTokens: 2 }; });
    const revoked = await owner(service), refused = await service.reserve(revoked.input);
    await fixture`UPDATE brainchain_execution_authorities SET revoked_at=clock_timestamp() WHERE id=${revoked.authorityId}`;
    await expect(service.dispatch(refused.capability, { binding: refused.binding, prompt: revoked.input.prompt }, new AbortController().signal)).rejects.toMatchObject({ code: 'execution_refused' });
    expect(calls).toBe(0);
    const context = await owner(service), reserved = await service.reserve(context.input);
    const pending = service.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal); await called;
    await fixture`UPDATE brainchain_worker_tasks SET lease_generation=lease_generation+1 WHERE id=${context.input.taskId}`;
    release(); const result = await pending;
    expect(result.state).toBe('settled'); expect(result.chargedMicros).toBe('13'); expect(result.response).toBeUndefined(); expect(calls).toBe(1);
  });

  test('expiry after a budget lock wait prevents dispatch and a provider timeout keeps the uncertain hold', async () => {
    let calls = 0; let received: AbortSignal | undefined;
    const service = create(async (_request, signal) => { calls++; received = signal; return new Promise(() => {}); });
    const context = await owner(service);
    const reserved = await service.reserve({ ...context.input, deadlineMs: Date.now()+350 });
    let release!: () => void; let started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }); const called = new Promise<void>(resolve => { started = resolve; });
    const holder = fixture.begin(async tx => { await tx`SELECT b.id FROM brainchain_compute_budgets b JOIN brainchain_compute_envelopes e ON e.budget_id=b.id WHERE e.id=${context.envelopeId} FOR UPDATE OF b`; started(); await wait; });
    await called;
    const blocked = service.dispatch(reserved.capability, { binding: reserved.binding, prompt: context.input.prompt }, new AbortController().signal).then(() => 'accepted', error => String(error.code));
    await Bun.sleep(450); release(); await holder; expect(await blocked).toBe('execution_refused'); expect(calls).toBe(0);
    await service.cancelReserved(reserved.binding.callId);
    const next = await owner(service), timed = await service.reserve({ ...next.input, deadlineMs: Date.now()+300 });
    await expect(service.dispatch(timed.capability, { binding: timed.binding, prompt: next.input.prompt }, new AbortController().signal)).rejects.toMatchObject({ code: 'expired' });
    expect(calls).toBe(1); expect(received?.aborted).toBe(true);
    expect((await service.inspectCall(timed.binding.callId)).state).toBe('uncertain');
  });

  test.skipIf(process.env.BRAINCHAIN_DOCKER_FIXTURE !== '1')('actual durable PostgreSQL proxy, pinned container, and core child share one verified receipt', async () => {
    let calls = 0;
    const service = create(async () => { calls++; return { text: ' exact persisted provider fixture ', inputTokens: 10, outputTokens: 2 }; });
    const context = await owner(service), reserved = await service.reserve(context.input);
    const bundlePath = resolve(import.meta.dir, '../../../../../.brainchain-work/isolated-task-parent-worker.js');
    const bytes = await readFile(bundlePath);
    const result = await runBrainchainIsolatedProcess({ bundle: { bundlePath, bundleSha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') },
      binding: reserved.binding, brief: 'Return a bounded text answer.', capability: reserved.capability, proxy: service });
    expect(result.result.text).toBe(' exact persisted provider fixture ');
    expect(result.receipt.state).toBe('settled'); expect(result.receipt.chargedMicros).toBe('13');
    const persisted = (await service.status(reserved.capability)).response;
    if (!persisted) throw new Error('Fixture receipt response missing');
    expect(result.result.text).toBe(persisted.text); expect(calls).toBe(1);
  }, 20000);
});
