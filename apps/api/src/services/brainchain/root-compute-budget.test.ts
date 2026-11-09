import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { rootComputeDocumentBytes, rootComputeDocumentHash, SignedRootComputeBudgetAuthority, type RootComputeDocument, type SignedRootComputeDocument } from './root-compute-budget';

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyHex = (keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
  const now = Date.now(); const jobId = randomUUID(), reservationId = randomUUID();
  const first: RootComputeDocument = { kind: 'clawville-root-compute-v1', jobId, revision: 1, previousDocumentHash: null,
    issuedAtMs: now - 1000, expiresAtMs: now + 60_000,
    providers: { openai: { capMicros: '10000000', spentMicros: '0' }, openrouter: { capMicros: '10000000', spentMicros: '0' } },
    reservations: [{ rootReservationId: reservationId, provider: 'openai', approvalRef: 'root-review-1', limitMicros: '1000',
      expiresAtMs: now + 30_000, state: 'reserved', revoked: false, chargedMicros: null, reconciliationRef: null }] };
  const seal = (document: RootComputeDocument): SignedRootComputeDocument => {
    const bytes = rootComputeDocumentBytes(document);
    return { document: bytes, signatureHex: sign(null, Buffer.from(bytes), keys.privateKey).toString('hex') };
  };
  const sealed = seal(first); let history = [sealed]; let headCalls = 0;
  let headOverride: ((calls: number) => Record<string, unknown>) | undefined;
  const options = { publicKeyHex, jobId, genesisDocumentHash: rootComputeDocumentHash(sealed.document),
    loadHistory: async () => history, currentHead: async () => {
      headCalls++; return (headOverride?.(headCalls) ?? { jobId, revision: history.length,
        documentHash: rootComputeDocumentHash(history.at(-1)!.document), observedAtMs: Date.now() }) as never;
    } };
  const approval = { jobId, provider: 'openai' as const, rootReservationId: reservationId, approvalRef: 'root-review-1', limitMicros: 1000n,
    expiresAt: new Date(first.reservations[0]!.expiresAtMs) };
  const second = (): RootComputeDocument => ({ ...structuredClone(first), revision: 2, issuedAtMs: now - 500,
    previousDocumentHash: rootComputeDocumentHash(sealed.document) });
  return { first, second, seal, approval, options, replace: (value: SignedRootComputeDocument[]) => { history = value; },
    override: (value: typeof headOverride) => { headOverride = value; },
    append: (value: RootComputeDocument) => { history.push(seal(value)); },
    authority: () => new SignedRootComputeBudgetAuthority(options) };
}
const refuses = async (promise: Promise<void>) => { await expect(promise).rejects.toMatchObject({ code: 'budget_refused' }); };

test('exact signed reservation verifies without reading keys or creating approval', async () => {
  const f = fixture(); await expect(f.authority().verifyReservation(f.approval)).resolves.toBeUndefined();
});
test('each provider has its own cumulative cap and expired holds still count', async () => {
  const f = fixture(); const next = f.second();
  next.providers.openrouter.spentMicros = '10000000'; next.providers.openai.spentMicros = '9999000';
  f.append(next); await expect(f.authority().verifyReservation(f.approval)).resolves.toBeUndefined();
  const over = { ...structuredClone(next), revision: 3, issuedAtMs: next.issuedAtMs + 1,
    previousDocumentHash: rootComputeDocumentHash(f.seal(next).document) };
  over.reservations.push({ ...over.reservations[0]!, rootReservationId: randomUUID(), approvalRef: 'old-hold', limitMicros: '1', expiresAtMs: Date.now() - 100, revoked: true });
  f.append(over); await refuses(f.authority().verifyReservation(f.approval));
});
test('approval tuple, signer, signature and pinned job must all match', async () => {
  const f = fixture();
  for (const change of [{ jobId: randomUUID() }, { provider: 'openrouter' as const }, { rootReservationId: randomUUID() },
    { approvalRef: 'other-review' }, { limitMicros: 1001n }, { expiresAt: new Date(f.approval.expiresAt.getTime() + 1) }]) {
    await refuses(f.authority().verifyReservation({ ...f.approval, ...change }));
  }
  const other = fixture(); await refuses(new SignedRootComputeBudgetAuthority({ ...f.options, publicKeyHex: other.options.publicKeyHex }).verifyReservation(f.approval));
  const signed = { ...f.seal(f.first) }; signed.signatureHex = '0'.repeat(128);
  f.replace([signed]); await refuses(f.authority().verifyReservation(f.approval));
});
test('released, settled, uncertain, revoked or expired entries cannot authorize an envelope', async () => {
  for (const state of ['released', 'settled', 'uncertain', 'revoked', 'expired'] as const) {
    const f = fixture(); const next = f.second(); const item = next.reservations[0]!;
    if (state === 'revoked') item.revoked = true;
    else if (state === 'expired') f.approval.expiresAt = new Date(Date.now() - 1);
    else { item.state = state; if (state !== 'uncertain') { item.chargedMicros = '0'; item.reconciliationRef = 'root-close-1'; } }
    f.append(next); await refuses(f.authority().verifyReservation(f.approval));
  }
});
test('resigned divergent fields, missing IDs, duplicate IDs and approval references refuse', async () => {
  for (const fault of ['amount', 'expiry', 'approval', 'provider', 'missing', 'duplicate-id', 'duplicate-approval'] as const) {
    const f = fixture(); const next = f.second(); const item = next.reservations[0]!;
    if (fault === 'amount') item.limitMicros = '2000';
    if (fault === 'expiry') item.expiresAtMs += 1;
    if (fault === 'approval') item.approvalRef = 'replacement';
    if (fault === 'provider') item.provider = 'openrouter';
    if (fault === 'missing') next.reservations = [];
    if (fault === 'duplicate-id') next.reservations.push({ ...item, approvalRef: 'different' });
    if (fault === 'duplicate-approval') next.reservations.push({ ...item, rootReservationId: randomUUID() });
    f.append(next); await refuses(f.authority().verifyReservation(f.approval));
  }
});
test('uncertain holds cannot release, terminal charges cannot change, and revoked entries cannot reactivate', async () => {
  for (const fault of ['release-uncertain', 'reactivate', 'change-charge', 'unrevoke', 'reduce-spent'] as const) {
    const f = fixture(); const next = f.second(); const item = next.reservations[0]!;
    if (fault === 'release-uncertain') item.state = 'uncertain';
    else if (fault === 'unrevoke') item.revoked = true;
    else { item.state = 'settled'; item.chargedMicros = '100'; item.reconciliationRef = 'settled-1'; next.providers.openai.spentMicros = '100'; }
    f.append(next);
    const last = { ...structuredClone(next), revision: 3, issuedAtMs: next.issuedAtMs + 1, previousDocumentHash: rootComputeDocumentHash(f.seal(next).document) };
    const changed = last.reservations[0]!;
    if (fault === 'release-uncertain') { changed.state = 'released'; changed.chargedMicros = '0'; changed.reconciliationRef = 'release'; }
    if (fault === 'reactivate') { changed.state = 'reserved'; changed.chargedMicros = null; changed.reconciliationRef = null; }
    if (fault === 'change-charge') changed.chargedMicros = '99';
    if (fault === 'unrevoke') changed.revoked = false;
    if (fault === 'reduce-spent') last.providers.openai.spentMicros = '99';
    f.append(last); await refuses(f.authority().verifyReservation(f.approval));
  }
});
test('current head freshness, concurrent revision changes, expiry and bounded retained history refuse', async () => {
  for (const fault of ['stale', 'rollover', 'expiry', 'history'] as const) {
    const f = fixture();
    if (fault === 'history') f.replace(Array.from({ length: 65 }, () => f.seal(f.first)));
    else if (fault === 'expiry') { const next = f.second(); next.expiresAtMs = Date.now() - 1; next.reservations[0]!.expiresAtMs = next.expiresAtMs; f.append(next); }
    else f.override(calls => ({ jobId: f.approval.jobId, revision: fault === 'rollover' && calls > 1 ? 2 : 1,
      documentHash: f.options.genesisDocumentHash, observedAtMs: Date.now() - (fault === 'stale' ? 5001 : 0) }));
    await refuses(f.authority().verifyReservation(f.approval));
  }
});
test('noncanonical JSON, duplicate object fields, extra fields and malformed signature refuse', async () => {
  for (const fault of ['space', 'duplicate', 'unknown', 'signature'] as const) {
    const f = fixture(); const signed = { ...f.seal(f.first) };
    if (fault === 'space') signed.document += ' ';
    if (fault === 'duplicate') signed.document = signed.document.replace('{', '{"revision":1,');
    if (fault === 'unknown') signed.document = signed.document.replace('{', '{"extra":true,');
    if (fault === 'signature') signed.signatureHex = 'xyz';
    f.replace([signed]); await refuses(f.authority().verifyReservation(f.approval));
  }
});

test('uncertain settlement retains its exact charge while another active reservation verifies', async () => {
  const f = fixture(); const next = f.second(); const heldId = randomUUID();
  next.reservations.push({ ...next.reservations[0]!, rootReservationId: heldId, approvalRef: 'held-call', state: 'uncertain' });
  f.append(next);
  const settled = { ...structuredClone(next), revision: 3, issuedAtMs: next.issuedAtMs + 1,
    previousDocumentHash: rootComputeDocumentHash(f.seal(next).document) };
  settled.reservations[1]!.state = 'settled'; settled.reservations[1]!.chargedMicros = '120';
  settled.reservations[1]!.reconciliationRef = 'root-reconcile-1'; settled.providers.openai.spentMicros = '120';
  f.append(settled); await expect(f.authority().verifyReservation(f.approval)).resolves.toBeUndefined();
  const restarted = new SignedRootComputeBudgetAuthority(f.options);
  await expect(restarted.verifyReservation(f.approval)).resolves.toBeUndefined();
});
test('expired exact target and oversized signed document refuse', async () => {
  for (const oversized of [false, true]) {
    const f = fixture();
    if (!oversized) {
      f.first.reservations[0]!.expiresAtMs = Date.now() - 1;
      f.approval.expiresAt = new Date(f.first.reservations[0]!.expiresAtMs);
    }
    const signed = { ...f.seal(f.first) };
    if (oversized) signed.document = ' '.repeat(65_537);
    f.options.genesisDocumentHash = rootComputeDocumentHash(signed.document);
    f.replace([signed]); await refuses(f.authority().verifyReservation(f.approval));
  }
});

test('current-document verification and reservation verification use the same validated history', async () => {
  const f = fixture(); const authority = f.authority();
  expect(await authority.verifyCurrentDocument()).toEqual(f.first);
  await expect(authority.verifyReservation(f.approval)).resolves.toBeUndefined();
  const next = f.second(); next.reservations[0]!.revoked = true; f.append(next);
  expect((await authority.verifyCurrentDocument()).reservations[0]!.revoked).toBe(true);
  await refuses(authority.verifyReservation(f.approval));
});
test('empty pinned genesis validates without manufacturing an active reservation', async () => {
  const f = fixture(); f.first.reservations = []; const signed = f.seal(f.first);
  f.replace([signed]); f.options.genesisDocumentHash = rootComputeDocumentHash(signed.document);
  expect((await f.authority().verifyCurrentDocument()).reservations).toEqual([]);
  await refuses(f.authority().verifyReservation(f.approval));
});
