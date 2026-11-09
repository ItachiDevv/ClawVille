import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { encodeEventTopics, encodeFunctionResult, keccak256, pad, toBytes, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { buildIsolatedTaskPrompt } from '@clawville/agent-runtime/isolated-task';
import { BRAINCHAIN_CONTRACTS } from './contracts';
import { taskReadAbi, workerHireAbi } from './chain-client';
import { computeHash } from './inference-policy';
import { rootComputeDocumentBytes, rootComputeDocumentHash, type RootComputeDocument } from './root-compute-budget';
import type { Sql } from 'postgres';
import { BoundedBrainchainPaidTrial, paidTrialLimits } from './paid-trial';
import { ProtectedRootComputeStore } from './root-compute-store';

test('reviewed trial cost is exact and an oversized prompt refuses', () => {
  expect(paidTrialLimits('bounded task')).toEqual({ maxInputTokens: 4096, maxOutputTokens: 256, maximumMicros: 13312n });
  expect(() => paidTrialLimits('x'.repeat(3073))).toThrow();
  expect(() => paidTrialLimits('\u{1f30d}'.repeat(769))).toThrow();
});
test.skipIf(process.platform === 'linux')('direct Windows use refuses before database, credential or provider access', () => {
  if (process.platform === 'linux') return;
  expect(() => new BoundedBrainchainPaidTrial({ database: undefined as unknown as Sql, store: undefined as unknown as ProtectedRootComputeStore,
    expectedUid: 0, journalDirectory: '/fixture', bundle: { bundlePath: '/worker.js', bundleSha256: 'a'.repeat(64) } })).toThrow();
});
test.skipIf(process.platform !== 'linux')('missing real hire refuses preflight without any provider or filesystem mutation', async () => {
  let reads = 0;
  const database = { begin: async (action: (tx: unknown) => Promise<unknown>) => action(async (parts: TemplateStringsArray) => {
    if (parts.join('').includes('SELECT t.*')) reads++; return [];
  }) } as unknown as Sql;
  const runner = new BoundedBrainchainPaidTrial({ database, store: undefined as unknown as ProtectedRootComputeStore,
    expectedUid: process.getuid!(), journalDirectory: '/nonexistent-refused-journal', bundle: { bundlePath: '/worker.js', bundleSha256: 'a'.repeat(64) } });
  await expect(runner.preflight({ runId: randomUUID(), avatarId: randomUUID(), taskId: randomUUID(), authorityId: randomUUID(), rootReservationId: randomUUID(), brief: 'bounded' })).rejects.toMatchObject({ code: 'paid_trial_refused' });
  expect(reads).toBe(1);
  await expect(runner.run({} as never, {} as never)).rejects.toMatchObject({ code: 'paid_trial_refused' });
});

/** Contract-shaped controlled transport. Eligibility and all real parsing remain active. */
async function contractFixture() {
  const path = `/fixture/trial-${randomUUID()}`;
  await mkdir(`${path}/protected`, { recursive: true, mode: 0o700 }); await mkdir(`${path}/history`, { mode: 0o700 }); await mkdir(`${path}/journal`, { mode: 0o700 });
  const input = { runId: randomUUID(), avatarId: randomUUID(), taskId: randomUUID(), authorityId: randomUUID(), rootReservationId: randomUUID(), brief: 'Return one short answer.' };
  const worker = `0x${'1'.repeat(40)}` as Address, model = pad(worker, { size: 32 });
  const board = BRAINCHAIN_CONTRACTS.testnet.boards[0]!.address;
  const stableHash = `0x${'a'.repeat(64)}` as Hex, hireHash = `0x${'b'.repeat(64)}` as Hex, transactionHash = `0x${'c'.repeat(64)}` as Hex;
  const deadline = BigInt(Math.floor(Date.now()/1000)+3600), briefHash = keccak256(toBytes(input.brief)), promptHash = computeHash(buildIsolatedTaskPrompt(input.brief));
  const row = { id: input.taskId, avatar_id: input.avatarId, canonical: true, environment: 'testnet', chain_id: 274630, status: 2,
    address: worker, requested_state: 'running', revoked_at: null as Date | null, consumed_at: null as Date | null,
    authority_expires_at: new Date(Date.now()+60_000), authority_generation: 1, lease_generation: 0,
    prompt_hash: promptHash, input_hash: computeHash(input.brief), brief_hash: briefHash, authority_brief_hash: briefHash,
    deadline_unix: deadline.toString(), board_address: board, observed_block: '5000', observed_block_hash: stableHash,
    task_id: '7', hire_block: '4000', hire_block_hash: hireHash, hire_tx_hash: transactionHash, hire_log_index: 2 };
  const task = { poster: worker, bounty: 1000000n, deadline, status: 2, accepted: false, disputed: false, disputedByModel: false,
    model, briefHash, resultHash: `0x${'0'.repeat(64)}` as Hex, submittedAt: 0n, gradedAt: 0n, disputedAt: 0n, postedAt: 1n,
    payee: zeroAddress as Address, feeRecipient: zeroAddress, feeBps: 0, hireThresholdBps: 0, gradeThresholdBps: 0, ruleThresholdBps: 0,
    gradeWindow: 3600n, disputeWindow: 3600n, ruleWindow: 3600n };
  const log = { address: board, blockNumber: toHex(4000), blockHash: hireHash, transactionHash, logIndex: '0x2', removed: false,
    data: '0x', topics: encodeEventTopics({ abi: workerHireAbi, eventName: 'WorkerHired', args: { id: 7n, model, decisionId: 9n } }) as Hex[] };
  let reads = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe(BRAINCHAIN_CONTRACTS.testnet.rpc); expect(init?.redirect).toBe('manual'); reads++;
    const request = JSON.parse(String(init?.body)); let result: unknown;
    switch (request.method) {
      case 'eth_chainId': result = toHex(274630); break;
      case 'eth_blockNumber': result = toHex(5012); break;
      case 'eth_getBlockByNumber': {
        const hire = BigInt(request.params[0]) === 4000n;
        result = { number: hire ? toHex(4000) : toHex(5000), hash: hire ? hireHash : stableHash, timestamp: toHex(Math.floor(Date.now()/1000)-(hire ? 30 : 0)) }; break;
      }
      case 'eth_getCode': result = '0x01'; break;
      case 'eth_call': result = encodeFunctionResult({ abi: taskReadAbi, functionName: 'get', result: task }); break;
      case 'eth_getLogs': result = [log]; break;
      default: throw new Error('Unexpected fixture RPC method');
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  }) as typeof fetch;
  const database = { begin: async (action: (tx: unknown) => Promise<unknown>) => action(async (parts: TemplateStringsArray) => parts.join('').includes('SELECT t.*') ? [{ ...row }] : []) } as unknown as Sql;
  const keys = generateKeyPairSync('ed25519');
  const document: RootComputeDocument = { kind: 'clawville-root-compute-v1', jobId: randomUUID(), revision: 1, previousDocumentHash: null,
    issuedAtMs: Date.now()-1000, expiresAtMs: Date.now()+120_000,
    providers: { openai: { capMicros: '10000000', spentMicros: '0' }, openrouter: { capMicros: '10000000', spentMicros: '0' } },
    reservations: [{ rootReservationId: input.rootReservationId, provider: 'openai', approvalRef: 'ephemeral-preflight-fixture', limitMicros: '13312',
      expiresAtMs: Date.now()+60_000, state: 'reserved', revoked: false, chargedMicros: null, reconciliationRef: null }] };
  const documentText = rootComputeDocumentBytes(document), documentHash = rootComputeDocumentHash(documentText);
  const signed = { document: documentText, signatureHex: sign(null, Buffer.from(documentText), keys.privateKey).toString('hex') };
  const pinPath = `${path}/protected/pins.json`, headPath = `${path}/protected/head.json`;
  await writeFile(pinPath, JSON.stringify({ jobId: document.jobId, publicKeyHex: (keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), genesisDocumentHash: documentHash }), { mode: 0o600 });
  await writeFile(headPath, JSON.stringify({ jobId: document.jobId, revision: 1, documentHash }), { mode: 0o600 });
  const signedPath = `${path}/history/1-${documentHash}.json`; await writeFile(signedPath, JSON.stringify(signed), { mode: 0o600 });
  const store = await ProtectedRootComputeStore.open({ pinPath, headPath, historyDirectory: `${path}/history`, expectedUid: process.getuid!() });
  const runner = new BoundedBrainchainPaidTrial({ database, store, expectedUid: process.getuid!(), journalDirectory: `${path}/journal`,
    bundle: { bundlePath: '/unused-no-launch.js', bundleSha256: 'a'.repeat(64) }, readTransport: { fetch: fetcher, validateUrl: async url => ({ ok: true, url }) } });
  return { path, input, row, task, log, runner, store, reads: () => reads, corruptSignature: async () => { await writeFile(signedPath, JSON.stringify({ ...signed, signatureHex: '0'.repeat(128) }), { mode: 0o600 }); } };
}

test.skipIf(process.platform !== 'linux')('contract-shaped Hired preflight reaches a current signed reservation without credentials or provider invocation', async () => {
  const f = await contractFixture();
  expect(f.task.payee).toBe(zeroAddress); expect(f.log.topics.length).toBe(4);
  const ticket = await f.runner.preflight(f.input);
  expect(ticket.input.taskId).toBe(f.input.taskId); expect(ticket.maximumMicros).toBe('13312'); expect(ticket.approval.limitMicros).toBe(13312n);
  expect(f.reads()).toBeGreaterThan(5);
  const journal = JSON.parse(await readFile(`${f.path}/journal/${f.input.runId}-preflight.json`, 'utf8'));
  expect(journal.promptHash).toBe(ticket.promptHash); expect(Object.keys(journal)).not.toContain('credential');
});
test.skipIf(process.platform !== 'linux')('preflight rejects inconsistent task, full hire event, authority and root signature evidence', async () => {
  for (const fault of ['payee', 'model', 'missing-decision', 'extra-topic', 'decision-encoding', 'data', 'task-id', 'log-model', 'block-number', 'block-hash', 'transaction', 'log-index', 'removed', 'revoked', 'expired', 'consumed', 'root-signature'] as const) {
    const f = await contractFixture();
    if (fault === 'payee') f.task.payee = f.row.address;
    if (fault === 'model') f.task.model = `0x${'2'.repeat(64)}`;
    if (fault === 'missing-decision') f.log.topics.pop();
    if (fault === 'extra-topic') f.log.topics.push(toHex(1n, { size: 32 }));
    if (fault === 'decision-encoding') f.log.topics[3] = '0x01';
    if (fault === 'data') f.log.data = '0x00';
    if (fault === 'task-id') f.log.topics[1] = toHex(8n, { size: 32 });
    if (fault === 'log-model') f.log.topics[2] = `0x${'2'.repeat(64)}`;
    if (fault === 'block-number') f.log.blockNumber = toHex(4001);
    if (fault === 'block-hash') f.log.blockHash = `0x${'2'.repeat(64)}`;
    if (fault === 'transaction') f.log.transactionHash = `0x${'2'.repeat(64)}`;
    if (fault === 'log-index') f.log.logIndex = '0x3';
    if (fault === 'removed') f.log.removed = true;
    if (fault === 'revoked') f.row.revoked_at = new Date();
    if (fault === 'expired') f.row.authority_expires_at = new Date(Date.now()-1);
    if (fault === 'consumed') f.row.consumed_at = new Date();
    if (fault === 'root-signature') await f.corruptSignature();
    let refused: unknown; try { await f.runner.preflight(f.input); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ code: 'paid_trial_refused' });
  }
});
