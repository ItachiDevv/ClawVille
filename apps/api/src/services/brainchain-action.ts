import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { BRAINCHAIN_BUYER_STATES, BRAINCHAIN_SOLANA_BUYER_NETWORK } from '@clawville/shared';
import {fundingDraftSchema} from './brainchain/funding-exit-policy';
import { purchaseBodySchema } from './brainchain/purchase-policy';
import {exactCaptureIntentSchema} from './brainchain/exact-capture-policy';
import {exactRecoveryRequestSchema} from './brainchain/exact-result-recovery-consent';
import {workerOwnerPolicySchema} from './brainchain/worker-owner-policy';
export function decodeBrainchainPolicyDraft(op:string,draft:string):Record<string,unknown>{
  if(!/^[A-Za-z0-9_-]{1,6000}$/.test(draft))throw Error('Invalid policy draft');
  const bytes=Buffer.from(draft,'base64url');if(bytes.toString('base64url')!==draft||bytes.length>4096)throw Error('Invalid policy draft');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const scope={policyId:z.string().uuid(),revision:z.number().int().positive()};
  if(op==='policy_request')return workerOwnerPolicySchema.parse(value);
  if(op==='policy_narrow')return z.object({...scope,policy:workerOwnerPolicySchema}).strict().parse(value);
  if(op==='policy_start')return{...z.object({...scope,workerControlVersion:z.string().min(1).max(64)}).strict().parse(value),action:'start'};
  if(op==='policy_pause'||op==='policy_revoke')return{...z.object(scope).strict().parse(value),action:op.slice(7)};
  throw Error('Unsupported policy operation');
}
export function decodeBrainchainRecoveryDraft(op:string,draft:string):Record<string,unknown>{
 if(!/^[A-Za-z0-9_-]{1,6000}$/.test(draft))throw Error('Invalid recovery draft');
 const bytes=Buffer.from(draft,'base64url');if(bytes.toString('base64url')!==draft||bytes.length>4096)throw Error('Invalid recovery draft');
 const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 return op==='recovery_request'?exactRecoveryRequestSchema.parse(raw):exactRecoveryRequestSchema.omit({resultId:true,observationPolicy:true}).parse(raw);
}
export function decodeBrainchainPurchaseDraft(value: string) {
  if (!/^[A-Za-z0-9_-]{1,86000}$/.test(value)) throw new Error('Invalid purchase draft');
  const bytes=Buffer.from(value,'base64url');
  if(bytes.toString('base64url')!==value||bytes.byteLength>64000)throw new Error('Invalid purchase draft');
  return z.object({idempotencyKey:z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),body:purchaseBodySchema,publicDataConsent:z.literal(true),environment:z.literal('testnet'),network:z.enum(['eip155:84532',BRAINCHAIN_SOLANA_BUYER_NETWORK])}).strict().parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
}

export function decodeBrainchainFundingDraft(draft:string){if(!/^[A-Za-z0-9_-]{1,2048}$/.test(draft))throw Error('Invalid funding draft');const bytes=Buffer.from(draft,'base64url');if(bytes.toString('base64url')!==draft)throw Error('Invalid funding draft');return fundingDraftSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('tasks'), workerId: z.string().uuid() }).strict(),
 z.object({op:z.literal('funding_list')}).strict(),
 z.object({op:z.literal('funding_create'),draft:z.string().max(2048)}).strict(),
 z.object({op:z.enum(['funding_get','funding_intent','funding_submit','funding_recover','funding_reconcile']),operationId:z.string().uuid()}).strict(),
  z.object({op:z.literal('recovery'),workerId:z.string().uuid()}).strict(),
  z.object({op:z.literal('recovery_request'),workerId:z.string().uuid(),draft:z.string().max(6000)}).strict(),
  z.object({op:z.literal('recovery_narrow'),workerId:z.string().uuid(),consentId:z.string().uuid(),draft:z.string().max(6000)}).strict(),
  z.object({op:z.literal('recovery_revoke'),workerId:z.string().uuid(),consentId:z.string().uuid()}).strict(),
  z.object({op:z.literal('policy'),workerId:z.string().uuid()}).strict(),
  z.object({op:z.enum(['policy_request','policy_narrow','policy_start','policy_pause','policy_revoke']),workerId:z.string().uuid(),draft:z.string().max(6000)}).strict(),
  z.object({op:z.literal('purchase_list')}).strict(),
  z.object({op:z.literal('purchase_draft'),draft:z.string().max(86000).refine(value=>{try{decodeBrainchainPurchaseDraft(value);return true;}catch{return false;}})}).strict(),
  z.object({op:z.enum(['purchase_get','purchase_quote','purchase_submit','purchase_recover','purchase_reconcile','purchase_cancel']),orderId:z.string().uuid()}).strict(),
  z.object({op:z.literal('purchase_intent'),orderId:z.string().uuid(),payer:z.string().regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/)}).strict(),
  z.object({ op: z.enum(['knowledge', 'status', 'install', 'workers']) }).strict(),
  z.object({ op: z.literal('binding_challenge'), environment: z.enum(['testnet', 'mainnet']), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).strict(),
  z.object({ op: z.literal('bind'), nonce: z.string().regex(/^[0-9a-f]{64}$/), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict(),
  z.object({ op: z.literal('control'), workerId: z.string().uuid(), requestedState: z.enum(['paused', 'draining']) }).strict(),
  z.object({ op: z.literal('earnings'), workerId: z.string().uuid(), board: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
    fromBlock: z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(value => value.length <= 20 && /^\d+$/.test(value) && BigInt(value) < 2n ** 64n).optional() }).strict(),
  z.object({ op: z.literal('identity_credit'), workerId: z.string().uuid(),
    agentId: z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => value.length <= 78 && /^\d+$/.test(value) && BigInt(value) < 2n ** 256n) }).strict(),
]);
export type BrainchainActionInput = z.infer<typeof operationSchema>;
export interface BrainchainActionResult {
  op: BrainchainActionInput['op'];
  status: number;
  ok: boolean;
  expiresAt: number;
  data: Record<string, unknown>;
}

/** No free text, duplicate keys, authority fields, or wallet secrets enter this grammar. */
export function parseBrainchainActionParams(raw: string): BrainchainActionInput | null {
  if (!raw || raw.length > (raw.startsWith('op=purchase_draft,') ? 86500 : raw.startsWith('op=funding_create,')?2200: (raw.startsWith('op=policy_')||raw.startsWith('op=recovery_'))?6500:1024)) return null;
  const params: Record<string, string> = Object.create(null);
  for (const part of raw.split(',')) {
    const match = /^\s*([a-zA-Z][a-zA-Z0-9]*)\s*=\s*([a-zA-Z0-9:_-]+)\s*$/.exec(part);
    if (!match || Object.hasOwn(params, match[1]!)) return null;
    params[match[1]!] = match[2]!;
  }
  return validateBrainchainAction(params);
}

export function validateBrainchainAction(input: unknown): BrainchainActionInput | null {
  const result = operationSchema.safeParse(input);
  if(!result.success)return null;
  if(result.data.op==='funding_create'){try{decodeBrainchainFundingDraft(result.data.draft);}catch{return null;}}
  if(result.data.op.startsWith('policy_')&&'draft'in result.data){try{decodeBrainchainPolicyDraft(result.data.op,result.data.draft);}catch{return null;}}
  if(result.data.op.startsWith('recovery_')&&'draft'in result.data){try{decodeBrainchainRecoveryDraft(result.data.op,result.data.draft);}catch{return null;}}
  return result.data;
}

const purchaseOrder = z.object({id:z.string().uuid(),environment:z.literal('testnet'),chainId:z.literal(84532).nullable(),network:z.enum(['eip155:84532',BRAINCHAIN_SOLANA_BUYER_NETWORK]).optional(),state:z.enum(BRAINCHAIN_BUYER_STATES),bodyHash:z.string().regex(/^[a-f0-9]{64}$/),payer:z.string().regex(/^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/).nullable(),amountAtomic:z.literal('1000000'),remoteOrder:z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),remoteState:z.string().regex(/^[a-z-]{1,24}$/).nullable(),taskId:z.string().regex(/^[1-9][0-9]{0,77}$/).nullable(),taskBoard:z.string().regex(/^0x[0-9a-f]{40}$/).nullable(),paymentTransaction:z.string().regex(/^(0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/).nullable(),refundTransaction:z.string().regex(/^(0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/).nullable(),recovery:z.object({state:z.enum(['not_started','incomplete','not_found','unavailable','ambiguous','payment_observed']),checkedAt:z.string().datetime().nullable(),scannedTransactions:z.number().int().min(0).max(12),hasMore:z.boolean(),refundRelease:z.literal('unavailable'),refundReleaseReason:z.literal('order_attribution_unverified')}).optional(),requiresHumanApproval:z.boolean(),humanApproved:z.boolean(),provisional:z.literal(true)});
const worker = z.object({ id: z.string().uuid(), environment: z.enum(['testnet', 'mainnet']),
  chainId: z.number().int(), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  requestedState: z.enum(['paused', 'draining', 'running']), observedEligibility: z.enum(['eligible', 'ineligible', 'unknown']).nullable() });
const challenge = z.object({ nonce: z.string().regex(/^[0-9a-f]{64}$/), messageToSign: z.string().min(1).max(3000), expiresAt: z.string().datetime() });
const installation = z.object({ installed: z.enum(['runtime', 'marker', 'already']), version: z.number().int(), contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/), consumptionVerified: z.literal(false) });
const amount = z.string().regex(/^(0|[1-9]\d{0,77})$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
// Mirrors listWorkerTasks. Validate every row before selecting the private preview.
export const brainchainTasksResponseSchema = z.object({
  tasks: z.array(z.object({
    id: z.string().uuid(), boardAddress: address,
    taskId: z.string().regex(/^\d{1,78}$/).refine(value => BigInt(value) < 2n ** 256n),
    status: z.number().int().min(1).max(9),
    bountyAtomic: z.string().regex(/^\d{1,39}$/).refine(value => BigInt(value) < 2n ** 128n),
    deadlineUnix: amount, canonical: z.boolean(), observedBlock: amount, observedBlockHash: hash,
    hireBlock: amount, hireBlockHash: hash, hireTransaction: hash,
    hireLogIndex: z.number().int().min(0).max(2147483647),
    briefHash: hash, resultHash: hash, updatedAt: z.string().datetime(), provisional: z.literal(true),
  }).strict()).max(100),
  provisional: z.literal(true),
}).strict();
const earnings = z.object({ workerId: z.string().uuid(), environment: z.enum(['mainnet', 'testnet']), chainId: z.number().int().positive(), address,
  observedAt: z.string().datetime(), blockAgeSeconds: z.number().int().nonnegative(), provisional: z.literal(true),
  freshness: z.object({ state: z.enum(['recent', 'stale']), maxBlockAgeSeconds: z.literal(120) }),
  block: z.object({ number: amount, hash, timestamp: amount }), balances: z.object({ gasWei: amount, brainAtomic: amount, usdgAtomic: amount }),
  stake: z.object({ stakedAtomic: amount, unstakingAtomic: amount, unlocksAtUnix: amount, priceAtomic: amount, registered: z.boolean(), held: amount }),
  history: z.object({ boardAddress: address, deploymentBlock: amount, fromBlock: amount, throughBlock: amount.nullable(), nextBlock: amount.nullable(),
    coverage: z.literal('selected_board_range'), pageNetAtomic: amount,
    boards: z.array(z.object({ address, fromBlock: amount, release: z.string().regex(/^\d+\.\d+\.\d+$/).max(20) })).max(5),
    receipts: z.array(z.object({ taskId: amount, transactionHash: hash, logIndex: amount, blockNumber: amount, blockHash: hash,
      bountyAtomic: amount, feeAtomic: amount, netAtomic: amount })).max(10) }) });
const usd = z.string().regex(/^(0|[1-9]\d{0,77})(?:\.\d{1,18})?$/);
const safeCount = z.number().int().nonnegative().safe();
const sourceTime = z.string().datetime({ offset: true });
const identityCredit = z.object({ workerId: z.string().uuid(), agentId: amount, environment: z.enum(['mainnet', 'testnet']), observedAt: sourceTime, provisional: z.literal(true),
  identity: z.union([
    z.object({ state: z.literal('verified'), chainId: z.literal(4663), owner: address, registeredWallet: address, association: z.enum(['owner', 'registered_wallet', 'both']),
      block: z.object({ number: amount, hash, timestamp: amount }), blockAgeSeconds: safeCount }),
    z.object({ state: z.enum(['unavailable', 'not_associated', 'unsupported_testnet', 'stale']) }),
  ]),
  reputation: z.union([
    z.object({ state: z.literal('observed'), issuer: address, tag1: z.literal('brainchain'), tag2: z.literal('task'), count: amount,
      summaryValue: z.string().regex(/^-?(0|[1-9]\d{0,38})$/), summaryValueDecimals: z.number().int().min(0).max(18) }),
    z.object({ state: z.enum(['unavailable', 'not_requested']) }),
  ]),
  record: z.union([
    z.object({ state: z.enum(['observed', 'stale']), owner: address, asOf: sourceTime, ageSeconds: safeCount, isRoot: z.boolean(), backerId: amount.nullable(),
      line: usd, available: usd, drawn: usd, premiumBps: z.number().int().min(0).max(10_000), loansRepaid: safeCount, qualifiedRepaid: safeCount,
      volumeRepaid: usd, feesPaid: usd, score: z.number().int().min(0).max(1000), defaulted: z.boolean(), frozen: z.boolean(),
      openLoans: z.object({ state: z.enum(['none', 'terms_unavailable']), count: safeCount }) }),
    z.object({ state: z.enum(['unavailable', 'not_requested', 'unsupported_id', 'no_record']) }),
  ]),
  routes: z.union([
    z.object({ state: z.enum(['observed', 'stale']), owner: address,
      asOf: z.object({ snapshot: sourceTime.nullable(), stocks: sourceTime.nullable(), directoryBlock: amount.nullable() }),
      snapshotAgeSeconds: safeCount.nullable(), stocksAgeSeconds: safeCount.nullable(), ownerDefaulted: z.boolean().nullable(),
      options: z.array(z.object({ route: z.enum(['treasury_invite', 'ethos_lane', 'stock_line', 'own_priors']), open: z.boolean().nullable(),
        line: usd.nullable(), bond: usd.nullable(), room: usd.nullable(), upTo: usd.nullable(), maxLine: usd.nullable(), weekLeft: usd.nullable() })).max(4) }),
    z.object({ state: z.enum(['unavailable', 'not_requested', 'unsupported_id']) }),
  ]),
});
const observation = z.object({ observedAt: z.string().datetime(), expiresAt: z.string().datetime(), executionEnabled: z.literal(false),
  payment: z.union([
    z.object({ state: z.literal('observed'), offers: z.array(z.object({ network: z.string().regex(/^(?:eip155:\d{1,20}|solana:[A-Za-z0-9]{1,64})$/), amount: z.string().regex(/^\d{1,78}$/), asset: z.string().regex(/^(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/) })).max(16) }),
    z.object({ state: z.literal('unavailable') }),
  ]) });

/** Pick only our own validated fields. Never inject raw partner text into decision instructions. */
export function selectBrainchainActionResult(op: BrainchainActionInput['op'], status: number, body: unknown, now = Date.now()): BrainchainActionResult {
  const result: BrainchainActionResult = { op, status, ok: status >= 200 && status < 300, expiresAt: now + 300_000, data: {} };
  if (!result.ok) {
    const code = z.object({ error: z.string().regex(/^[a-z_]{1,80}$/) }).safeParse(body);
    result.data = { error: code.success ? code.data.error : 'brainchain_unavailable' };
    return result;
  }
  if(op.startsWith('funding_')){
   const view=z.object({id:z.string().uuid(),workerId:z.string().uuid(),kind:z.enum(['parent_eth','parent_exit']),state:z.enum(['reserved','captured','sending','uncertain','source_observed','reorg_suspended']),source:address,destination:address,sourceChain:z.union([z.literal(46630),z.literal(274630)]),destinationChain:z.union([z.literal(46630),z.literal(274630)]),amountAtomic:amount,feeAtomic:amount,minimumDestinationAtomic:amount,maxGasCostWei:amount,artifactHash:z.string().regex(/^[a-f0-9]{64}$/),artifactExpiresAt:sourceTime,sourceToken:address.nullable(),destinationToken:address.nullable(),sourceTransaction:hash.nullable(),sourceEvidence:z.object({transaction:hash,blockNumber:amount,blockHash:hash,observedAt:sourceTime,finalized:z.boolean(),destination:z.literal('unresolved')}).nullable(),deskReport:z.object({state:z.enum(['waiting','paying','paid','returning','returned','held']),payoutTransaction:hash.nullable(),returnTransaction:hash.nullable(),observedAt:sourceTime,attribution:z.literal('unverified')}).nullable(),destinationState:z.literal('unresolved'),liabilityState:z.literal('reserved'),executionEnabled:z.boolean(),createdAt:sourceTime,updatedAt:sourceTime});
   if(op==='funding_list')result.data=z.object({operations:z.array(view).max(30),executionEnabled:z.boolean()}).parse(body);
   else if(op==='funding_intent')result.data={notice:'Use the private external wallet endpoint. Signing payloads stay outside model observations.'};
   else result.data=z.object({operation:view}).parse(body);
  }else if(op==='recovery'||op.startsWith('recovery_')){
    const view=z.object({id:z.string().uuid(),workerId:z.string().uuid(),resultId:z.string().uuid(),state:z.enum(['requested','approved','revoked']),payloadHash:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.string().datetime(),executionEnabled:z.literal(false),payload:z.object({resultHash:hash,resultSha256:z.string().regex(/^[a-f0-9]{64}$/),hireSnapshotHash:z.string().regex(/^[a-f0-9]{64}$/),taskGeneration:z.number().int().positive(),signerGeneration:z.number().int().positive(),stages:z.array(z.enum(['signature','upload','prepare-submit','capture-submit','broadcast','reconcile'])).max(6),captureIntent:exactCaptureIntentSchema.optional(),captured:z.object({operationId:z.string().uuid(),nonce:amount.nullable(),transactionHash:hash.nullable(),gasWei:amount}).nullable().optional(),maxGasWei:amount,observationPolicy:z.enum(['legacy-depth12-age120-v1','nitro-testnet-latest-v1'])})});
    result.data=op==='recovery'?z.object({consents:z.array(view).max(2),results:z.array(z.object({id:z.string().uuid(),resultHash:hash,resultSha256:z.string().regex(/^[a-f0-9]{64}$/),hireSnapshotHash:z.string().regex(/^[a-f0-9]{64}$/),state:z.string().max(32)})).max(5)}).parse(body):view.parse(body);
    // Decision receipts describe state; they never grant execution authority.
    const views=op==='recovery'?(result.data.consents as {expiresAt:string}[]):[result.data as {expiresAt:string}];
    const future=views.map(view=>Date.parse(view.expiresAt)).filter(expiry=>Number.isFinite(expiry)&&expiry>now);
    result.expiresAt=Math.min(now+30_000,...future);
  }else if(op==='policy'||op.startsWith('policy_')){
    const view=z.object({id:z.string().uuid(),workerId:z.string().uuid(),revision:z.number().int().positive(),policy:workerOwnerPolicySchema,policyHash:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['requested','active','paused','revoked']),ownerApproved:z.boolean(),executionEnabled:z.literal(false)});
    result.data=op==='policy'?z.object({policy:view.nullable(),workerControlVersion:z.string().min(1).max(64),executionEnabled:z.literal(false)}).parse(body):view.parse(body);
  }else if (op === 'binding_challenge') {
    result.data = challenge.parse(body);
    result.expiresAt = Date.parse(String(result.data.expiresAt));
    if (result.expiresAt <= now || result.expiresAt > now + 125_000) throw new Error('Invalid challenge lifetime');
  } else if(op==='purchase_list'){const selected=z.object({orders:z.array(purchaseOrder).max(30),availability:z.object({environment:z.literal('testnet'),network:z.enum(['eip155:84532',BRAINCHAIN_SOLANA_BUYER_NETWORK]),executionEnabled:z.boolean()})}).parse(body);result.data={...selected,orders:selected.orders.slice(0,10)};}
  else if(op.startsWith('purchase_'))result.data=z.object({order:purchaseOrder}).parse(body);
  else if (op === 'tasks') {
    const selected = brainchainTasksResponseSchema.parse(body);
    result.data = { tasks: selected.tasks.slice(0, 5), provisional: true, indexedCount: selected.tasks.length, truncated: selected.tasks.length > 5 };
  }
  else if (op === 'workers') result.data = z.object({ workers: z.array(worker).max(2) }).parse(body);
  else if (op === 'bind' || op === 'control') result.data = z.object({ worker }).parse(body);
  else if (op === 'install') result.data = installation.parse(body);
  else if (op === 'earnings') result.data = earnings.parse(body);
  else if (op === 'identity_credit') {
    const selected = identityCredit.parse(body);
    result.data = selected;
    if (selected.identity.state === 'verified') {
      // Absolute source deadlines include response transport time. Stale data stays explicitly stale.
      const deadline = (timestamp: number, seconds: number) => Number.isSafeInteger(timestamp) && timestamp <= now + 30_000
        ? timestamp + seconds * 1000 : now;
      const parentSeconds = BigInt(selected.identity.block.timestamp);
      const deadlines = [now + 120_000, parentSeconds <= 8_640_000_000_000n ? deadline(Number(parentSeconds) * 1000, 120) : now];
      if (selected.record.state === 'observed') deadlines.push(deadline(Date.parse(selected.record.asOf), 300));
      if (selected.routes.state === 'observed') {
        deadlines.push(selected.routes.asOf.snapshot === null ? now : deadline(Date.parse(selected.routes.asOf.snapshot), 300));
        deadlines.push(selected.routes.asOf.stocks === null ? now : deadline(Date.parse(selected.routes.asOf.stocks), 900));
      }
      if (selected.record.state === 'no_record' && selected.routes.state !== 'observed') deadlines.push(now);
      result.expiresAt = Math.max(now, Math.min(...deadlines));
    }
  }
  else if (op === 'knowledge') result.data = z.object({ version: z.number().int(), contentHash: z.string().regex(/^[0-9a-f]{64}$/), reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(body);
  else result.data = z.object({ observation }).parse(body);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 8192) throw new Error('Office result exceeds its limit');
  return result;
}

/** Same REST handlers, same canonical session resolver; no caller-supplied identity reaches a service. */
export async function runBrainchainHostedAction(input: {
  actor: { sessionId: string; expectedAgentId: string; expectedAvatarId: string };
  operation: BrainchainActionInput;
  isCurrent: () => boolean;
}): Promise<BrainchainActionResult> {
  const [{ resolveAgentSession }, { isGuestUser }, { createBrainChainRoutes }] = await Promise.all([
    import('../middleware/require-auth-or-agent'), import('../middleware/require-non-guest'), import('../routes/brainchain'),
  ]);
  const expected = await resolveAgentSession(input.actor.sessionId);
  if (!input.isCurrent() || !expected?.ledgerCapable || !expected.userId
    || expected.agentId !== input.actor.expectedAgentId || expected.avatarId !== input.actor.expectedAvatarId
    || await isGuestUser(expected.userId)) throw new HTTPException(403, { message: 'BrainChain requires the current bound avatar' });
  const router = createBrainChainRoutes(undefined, {
    assertIdentity(identity) {
      if (!input.isCurrent() || identity.kind !== 'agent' || !identity.ledgerCapable
        || identity.sessionId !== input.actor.sessionId || identity.agentId !== expected.agentId
        || identity.avatarId !== expected.avatarId || identity.userId !== expected.userId) {
        throw new HTTPException(403, { message: 'BrainChain actor changed' });
      }
    },
  });
  let path: string, body: Record<string, unknown> | undefined;
  const op = input.operation;
  if(op.op==='funding_list')path='/funding-exit';
  else if(op.op==='funding_create'){path='/funding-exit';body=decodeBrainchainFundingDraft(op.draft);}
  else if('operationId'in op){path=`/funding-exit/${op.operationId}${op.op==='funding_get'?'':`/${op.op.slice(8)}`}`;if(op.op!=='funding_get')body={};}
  else if(op.op==='recovery')path=`/workers/${op.workerId}/recovery`;
  else if(op.op==='recovery_request'){path=`/workers/${op.workerId}/recovery`;body=decodeBrainchainRecoveryDraft(op.op,op.draft);}
  else if(op.op==='recovery_narrow'){path=`/workers/${op.workerId}/recovery/${op.consentId}/narrow`;body=decodeBrainchainRecoveryDraft(op.op,op.draft);}
  else if(op.op==='recovery_revoke'){path=`/workers/${op.workerId}/recovery/${op.consentId}/revoke`;body={};}
  else if(op.op==='policy')path=`/workers/${op.workerId}/policy`;
  else if(op.op==='policy_request'||op.op==='policy_narrow'||op.op==='policy_start'||op.op==='policy_pause'||op.op==='policy_revoke'){
    path=`/workers/${op.workerId}/policy${op.op==='policy_request'?'':op.op==='policy_narrow'?'/narrow':'/control'}`;body=decodeBrainchainPolicyDraft(op.op,op.draft);
  }
  else if(op.op==='purchase_list')path='/purchases';
  else if(op.op==='purchase_draft'){path='/purchases';body=decodeBrainchainPurchaseDraft(op.draft);}
  else if(op.op==='purchase_intent'){path=`/purchases/${op.orderId}/intent`;body={payer:op.payer};}
  else if('orderId'in op){path=`/purchases/${op.orderId}${op.op==='purchase_get'?'':`/${op.op.slice(9)}`}`;if(op.op!=='purchase_get')body={};}
  else if (op.op === 'binding_challenge') { path = '/workers/challenge'; body = { environment: op.environment, address: op.address }; }
  else if (op.op === 'bind') { path = '/workers/bind'; body = { nonce: op.nonce, signature: op.signature }; }
  else if (op.op === 'control') { path = `/workers/${op.workerId}/control`; body = { requestedState: op.requestedState }; }
  else if (op.op === 'earnings') {
    const query = new URLSearchParams();
    if (op.board) query.set('board', op.board);
    if (op.fromBlock) query.set('fromBlock', op.fromBlock);
    path = `/workers/${op.workerId}/earnings${query.size ? `?${query}` : ''}`;
  }
  else if (op.op === 'tasks') path = `/workers/${op.workerId}/tasks`;
  else if (op.op === 'identity_credit') { path = `/workers/${op.workerId}/identity-credit?agentId=${op.agentId}`; }
  else { path = `/${op.op}`; if (op.op === 'install') body = {}; }
  const response = await router.request(`http://office.internal${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'X-Clawville-Agent-Session': input.actor.sessionId, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return selectBrainchainActionResult(op.op, response.status, await response.json());
}
