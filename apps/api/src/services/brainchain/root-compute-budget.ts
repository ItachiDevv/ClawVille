import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { BrainchainComputeError, COMPUTE_JOB_CAP_MICROS } from './inference-policy';
import type { RootComputeBudgetAuthority, RootComputeEnvelopeApproval } from './inference-proxy';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const milliseconds = z.number().int().positive().safe();
const amount = z.string().regex(/^(0|[1-9][0-9]{0,7})$/).refine(value => BigInt(value) <= COMPUTE_JOB_CAP_MICROS);
const reference = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/);
const reservationSchema = z.object({
  rootReservationId: uuid, provider: z.enum(['openai', 'openrouter']), approvalRef: reference,
  limitMicros: amount.refine(value => BigInt(value) > 0n), expiresAtMs: milliseconds,
  state: z.enum(['reserved', 'uncertain', 'settled', 'released']), revoked: z.boolean(),
  chargedMicros: amount.nullable(), reconciliationRef: reference.nullable(),
}).strict();
const providerSchema = z.object({ capMicros: z.literal('10000000'), spentMicros: amount }).strict();
const documentSchema = z.object({
  kind: z.literal('clawville-root-compute-v1'), jobId: uuid, revision: z.number().int().positive().safe(),
  previousDocumentHash: hex.nullable(), issuedAtMs: milliseconds, expiresAtMs: milliseconds,
  providers: z.object({ openai: providerSchema, openrouter: providerSchema }).strict(),
  reservations: z.array(reservationSchema).max(128),
}).strict();
const headSchema = z.object({ jobId: uuid, revision: z.number().int().positive().safe(), documentHash: hex, observedAtMs: milliseconds }).strict();
export type RootComputeReservation = z.infer<typeof reservationSchema>;
export type RootComputeDocument = z.infer<typeof documentSchema>;
export type RootComputeHead = z.infer<typeof headSchema>;
export interface SignedRootComputeDocument { readonly document: string; readonly signatureHex: string }
export interface SignedRootBudgetOptions {
  readonly jobId: string;
  /** Raw 32-byte Ed25519 public key, never a private key. */
  readonly publicKeyHex: string;
  readonly genesisDocumentHash: string;
  /** Trusted deployment input. Never obtain this head from the signed document loader. */
  readonly currentHead: () => Promise<RootComputeHead>;
  /** Full retained history from revision one. No files or environment are read by this module. */
  readonly loadHistory: () => Promise<readonly SignedRootComputeDocument[]>;
}
function refused(): never { throw new BrainchainComputeError('budget_refused'); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
/** Exact UTF-8 bytes for external root signing. This function contains no signing authority. */
export function rootComputeDocumentBytes(value: RootComputeDocument): string { return canonical(documentSchema.parse(value)); }
export function rootComputeDocumentHash(document: string): string { return createHash('sha256').update(document, 'utf8').digest('hex'); }
function immutable(value: RootComputeReservation): string {
  return canonical({ rootReservationId: value.rootReservationId, provider: value.provider, approvalRef: value.approvalRef,
    limitMicros: value.limitMicros, expiresAtMs: value.expiresAtMs });
}
function checkDocument(document: RootComputeDocument, now: number): void {
  if (document.issuedAtMs > now || document.expiresAtMs <= document.issuedAtMs
    || document.expiresAtMs - document.issuedAtMs > 600_000) refused();
  const ids = new Set<string>(), approvals = new Set<string>();
  for (const item of document.reservations) {
    if (ids.has(item.rootReservationId) || approvals.has(item.approvalRef) || item.expiresAtMs > document.expiresAtMs) refused();
    ids.add(item.rootReservationId); approvals.add(item.approvalRef);
    if (item.state === 'reserved' || item.state === 'uncertain') {
      if (item.chargedMicros !== null || item.reconciliationRef !== null) refused();
    } else if (item.chargedMicros === null || item.reconciliationRef === null
      || BigInt(item.chargedMicros) > BigInt(item.limitMicros) || (item.state === 'released' && item.chargedMicros !== '0')) refused();
  }
  for (const provider of ['openai', 'openrouter'] as const) {
    const entries = document.reservations.filter(item => item.provider === provider);
    const held = entries.filter(item => item.state === 'reserved' || item.state === 'uncertain').reduce((total, item) => total + BigInt(item.limitMicros), 0n);
    const settled = entries.filter(item => item.state === 'settled').reduce((total, item) => total + BigInt(item.chargedMicros!), 0n);
    const spent = BigInt(document.providers[provider].spentMicros);
    if (spent < settled || spent + held > COMPUTE_JOB_CAP_MICROS) refused();
  }
}
function checkTransition(previous: RootComputeDocument, next: RootComputeDocument): void {
  if (next.issuedAtMs <= previous.issuedAtMs) refused();
  for (const provider of ['openai', 'openrouter'] as const) {
    if (BigInt(next.providers[provider].spentMicros) < BigInt(previous.providers[provider].spentMicros)) refused();
  }
  const entries = new Map(next.reservations.map(item => [item.rootReservationId, item]));
  for (const before of previous.reservations) {
    const after = entries.get(before.rootReservationId);
    if (!after || immutable(after) !== immutable(before) || (before.revoked && !after.revoked)) refused();
    if (before.state === 'settled' || before.state === 'released') {
      if (canonical(before) !== canonical(after)) refused();
    } else if (before.state === 'uncertain' && after.state !== 'uncertain' && after.state !== 'settled') refused();
  }
}
/** Approval-time verifier. Existing envelopes need a separate dispatch-time revocation fence. */
export class SignedRootComputeBudgetAuthority implements RootComputeBudgetAuthority {
  private readonly key: KeyObject;
  private readonly jobId: string;
  private readonly genesisHash: string;
  private readonly currentHead: SignedRootBudgetOptions['currentHead'];
  private readonly loadHistory: SignedRootBudgetOptions['loadHistory'];
  constructor(options: SignedRootBudgetOptions) {
    try {
      this.jobId = uuid.parse(options.jobId); this.genesisHash = hex.parse(options.genesisDocumentHash);
      const publicKey = hex.parse(options.publicKeyHex);
      if (typeof options.currentHead !== 'function' || typeof options.loadHistory !== 'function') refused();
      this.currentHead = options.currentHead; this.loadHistory = options.loadHistory;
      this.key = createPublicKey({ key: Buffer.from(`302a300506032b6570032100${publicKey}`, 'hex'), format: 'der', type: 'spki' });
    } catch { refused(); }
  }
  private async head(): Promise<RootComputeHead> {
    const value = headSchema.parse(await this.currentHead()); const now = Date.now();
    if (value.jobId !== this.jobId || value.observedAtMs > now || now - value.observedAtMs > 5000) refused();
    return value;
  }
  /** Validates the same complete history, including an empty pinned genesis. */
  async verifyCurrentDocument(): Promise<RootComputeDocument> {
    try {
      const head = await this.head(); const history = await this.loadHistory();
      if (!Array.isArray(history) || history.length < 1 || history.length > 64 || history.length !== head.revision) refused();
      let previous: RootComputeDocument | undefined, previousHash: string | null = null, bytes = 0;
      for (const signed of history) {
        if (!signed || Object.keys(signed).sort().join(',') !== 'document,signatureHex' || typeof signed.document !== 'string'
          || typeof signed.signatureHex !== 'string' || !/^[a-f0-9]{128}$/.test(signed.signatureHex)) refused();
        bytes += Buffer.byteLength(signed.document, 'utf8');
        if (bytes > 1_048_576 || Buffer.byteLength(signed.document, 'utf8') > 65_536) refused();
        const document = documentSchema.parse(JSON.parse(signed.document));
        // Exact canonical form also rejects duplicate JSON object keys and unknown fields.
        if (rootComputeDocumentBytes(document) !== signed.document || document.jobId !== this.jobId
          || document.revision !== (previous?.revision ?? 0) + 1 || document.previousDocumentHash !== previousHash
          || !verify(null, Buffer.from(signed.document, 'utf8'), this.key, Buffer.from(signed.signatureHex, 'hex'))) refused();
        const hash = rootComputeDocumentHash(signed.document);
        if (!previous && hash !== this.genesisHash) refused();
        checkDocument(document, Date.now()); if (previous) checkTransition(previous, document);
        previous = document; previousHash = hash;
      }
      const current = previous!; const latestHead = await this.head(); const now = Date.now();
      if (latestHead.revision !== head.revision || latestHead.documentHash !== head.documentHash
        || previousHash !== head.documentHash || current.expiresAtMs <= now) refused();
      return current;
    } catch { refused(); }
  }
  async verifyReservation(approval: RootComputeEnvelopeApproval): Promise<void> {
    try {
      if (approval.jobId !== this.jobId || !uuid.safeParse(approval.rootReservationId).success
        || !reference.safeParse(approval.approvalRef).success || !['openai', 'openrouter'].includes(approval.provider)
        || typeof approval.limitMicros !== 'bigint' || approval.limitMicros <= 0n || approval.limitMicros > COMPUTE_JOB_CAP_MICROS
        || !(approval.expiresAt instanceof Date) || !Number.isSafeInteger(approval.expiresAt.getTime())) refused();
      const current = await this.verifyCurrentDocument(); const now = Date.now();
      const target = current.reservations.find(item => item.rootReservationId === approval.rootReservationId);
      if (!target || target.state !== 'reserved' || target.revoked || target.provider !== approval.provider
        || target.approvalRef !== approval.approvalRef || BigInt(target.limitMicros) !== approval.limitMicros
        || target.expiresAtMs !== approval.expiresAt.getTime() || target.expiresAtMs <= now) refused();
    } catch { refused(); }
  }
}
