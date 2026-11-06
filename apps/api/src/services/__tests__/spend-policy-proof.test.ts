import { beforeEach, describe, expect, it } from 'bun:test';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { isSpendPolicyRaise } from '@clawville/shared';
import {
  _resetSpendProofNoncesForTest,
  buildApprovalMessage,
  buildSpendRulesMessage,
  issueApprovalChallenge,
  issueSpendProofChallenge,
  promptSha256,
  verifyApprovalProof,
  verifySpendProof,
} from '../spend-policy-proof';

const wallet = nacl.sign.keyPair();
const other = nacl.sign.keyPair();
const walletPubkey = bs58.encode(wallet.publicKey);
const VALUES = { dailyCapUsdCents: 500, perCallCapUsdCents: 50, allowedVendors: ['studios'], studiosKeyImagesPerDay: 10, studiosVideosPerDay: 2, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 1, requireApproval: false };

function sign(message: string, secretKey = wallet.secretKey): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), secretKey));
}

beforeEach(() => _resetSpendProofNoncesForTest());

describe('buildSpendRulesMessage', () => {
  it('names the account, each value and the nonce in readable text', () => {
    expect(buildSpendRulesMessage('user-1', VALUES, 'NONCE')).toBe(
      'ClawVille spend rules\naccount: user-1\ndaily cap: $5.00\nper-call cap: $0.50\npaid tools: studios\nStudios images per day with my own key: 10\nStudios videos per day: 2\nStudios character shots per day: 5\nStudios recasts per day: 1\nask me before each payment: no\nnonce: NONCE',
    );
    expect(buildSpendRulesMessage('user-1', { dailyCapUsdCents: null, perCallCapUsdCents: 0, allowedVendors: [], studiosKeyImagesPerDay: 0, studiosVideosPerDay: 2, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 1, requireApproval: true }, 'N'))
      .toContain('daily cap: not set\nper-call cap: $0.00\npaid tools: none');
  });
});

describe('verifySpendProof', () => {
  it('accepts the linked wallet signature for the exact values, once', () => {
    const challenge = issueSpendProofChallenge('user-1', VALUES);
    const signature = sign(challenge.messageToSign);
    const input = { userId: 'user-1', values: VALUES, nonce: challenge.nonce, signature, walletPubkey };
    expect(verifySpendProof(input)).toBe('ok');
    expect(verifySpendProof(input)).toBe('invalid_challenge');
  });

  it('refuses a signature for other values, even with a valid signature over them', () => {
    const challenge = issueSpendProofChallenge('user-1', VALUES);
    const higher = { ...VALUES, dailyCapUsdCents: 90_000 };
    const signature = sign(buildSpendRulesMessage('user-1', higher, challenge.nonce));
    expect(verifySpendProof({ userId: 'user-1', values: higher, nonce: challenge.nonce, signature, walletPubkey }))
      .toBe('invalid_challenge');
  });

  it('binds the own-key image count: a proof for 10 never saves 50', () => {
    const challenge = issueSpendProofChallenge('user-1', VALUES);
    const more = { ...VALUES, studiosKeyImagesPerDay: 50 };
    expect(verifySpendProof({ userId: 'user-1', values: more, nonce: challenge.nonce, signature: sign(challenge.messageToSign), walletPubkey }))
      .toBe('invalid_challenge');
  });

  it('refuses another user, another wallet and a garbage signature', () => {
    const a = issueSpendProofChallenge('user-1', VALUES);
    expect(verifySpendProof({ userId: 'user-2', values: VALUES, nonce: a.nonce, signature: sign(a.messageToSign), walletPubkey }))
      .toBe('invalid_challenge');
    const b = issueSpendProofChallenge('user-1', VALUES);
    expect(verifySpendProof({
      userId: 'user-1', values: VALUES, nonce: b.nonce, signature: sign(b.messageToSign, other.secretKey), walletPubkey,
    })).toBe('invalid_signature');
    const c = issueSpendProofChallenge('user-1', VALUES);
    expect(verifySpendProof({ userId: 'user-1', values: VALUES, nonce: c.nonce, signature: '0OIl', walletPubkey }))
      .toBe('invalid_signature');
  });

  it('treats vendor order as the same values', () => {
    const challenge = issueSpendProofChallenge('user-1', { ...VALUES, allowedVendors: ['studios'] });
    expect(challenge.messageToSign).toContain('paid tools: studios');
  });
});

describe('isSpendPolicyRaise', () => {
  const none = { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [] as string[], studiosKeyImagesPerDay: 10, studiosVideosPerDay: 2, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 1, requireApproval: false };
  it('counts set-from-unset, a higher cap and an added vendor as a raise', () => {
    expect(isSpendPolicyRaise(none, { ...none, dailyCapUsdCents: 0 })).toBe(true);
    expect(isSpendPolicyRaise(VALUES, { ...VALUES, perCallCapUsdCents: 51 })).toBe(true);
    expect(isSpendPolicyRaise({ ...VALUES, allowedVendors: [] }, VALUES)).toBe(true);
    expect(isSpendPolicyRaise(VALUES, { ...VALUES, studiosKeyImagesPerDay: 11 })).toBe(true);
  });
  it('counts a higher video, character-shot or recast count as a raise, and a lower one (0 = off) as not one', () => {
    for (const field of ['studiosVideosPerDay', 'studiosCharacterShotsPerDay', 'studiosRecastsPerDay'] as const) {
      expect(isSpendPolicyRaise(VALUES, { ...VALUES, [field]: VALUES[field] + 1 })).toBe(true);
      expect(isSpendPolicyRaise(VALUES, { ...VALUES, [field]: 0 })).toBe(false);
      expect(isSpendPolicyRaise({ ...VALUES, [field]: 0 }, VALUES)).toBe(true);
    }
  });
  it('counts equal, lower and cleared values as not a raise', () => {
    expect(isSpendPolicyRaise(VALUES, VALUES)).toBe(false);
    expect(isSpendPolicyRaise(VALUES, { ...VALUES, dailyCapUsdCents: 100 })).toBe(false);
    expect(isSpendPolicyRaise(VALUES, { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [], studiosKeyImagesPerDay: 10, studiosVideosPerDay: 2, studiosCharacterShotsPerDay: 5, studiosRecastsPerDay: 1, requireApproval: false })).toBe(false);
    expect(isSpendPolicyRaise(VALUES, { ...VALUES, studiosKeyImagesPerDay: 0 })).toBe(false);
    expect(isSpendPolicyRaise(none, none)).toBe(false);
  });
  it('counts turning off ask-me-before-each-payment as a raise, and turning it on as not one', () => {
    const asking = { ...VALUES, requireApproval: true };
    expect(isSpendPolicyRaise(asking, VALUES)).toBe(true);
    expect(isSpendPolicyRaise(VALUES, asking)).toBe(false);
    expect(isSpendPolicyRaise(asking, asking)).toBe(false);
    // On while a cap goes down: still not a raise.
    expect(isSpendPolicyRaise(VALUES, { ...asking, dailyCapUsdCents: 100 })).toBe(false);
  });
});

describe('approval proof ("ask me before each payment")', () => {
  const TERMS = {
    avatarId: 'avatar-1',
    requestId: 'req-1',
    operation: 'image' as const,
    mode: 'wallet' as const,
    maxUsdCents: 10,
    promptSha256: promptSha256('a crab'),
    paramsSha256: null as string | null,
    credentialSha256: null,
  };

  it('names the account, avatar, request, payer, the most it costs and the prompt hash', () => {
    expect(buildApprovalMessage('user-1', TERMS, 'NONCE')).toBe(
      `ClawVille payment approval\naccount: user-1\navatar: avatar-1\nrequest: req-1\ntool: Studios image\npays: my agent wallet, at most $0.10\nprompt sha256: ${promptSha256('a crab')}\nnonce: NONCE`,
    );
    expect(buildApprovalMessage('user-1', { ...TERMS, mode: 'account', maxUsdCents: null, credentialSha256: 'b'.repeat(64) }, 'N'))
      .toContain(`pays: my own Studios key (my Studios credits), key sha256: ${'b'.repeat(64)}`);
  });

  it('names the operation and the settings hash for every operation but image', () => {
    const video = { ...TERMS, operation: 'video' as const, paramsSha256: 'd'.repeat(64) };
    const message = buildApprovalMessage('user-1', video, 'N');
    expect(message).toContain('\ntool: Studios video\n');
    expect(message).toContain(`\nsettings sha256: ${'d'.repeat(64)}\nnonce: N`);
    expect(buildApprovalMessage('user-1', { ...TERMS, operation: 'character_shots' }, 'N')).toContain('tool: Studios character shots');
    expect(buildApprovalMessage('user-1', { ...TERMS, operation: 'recast' }, 'N')).toContain('tool: Studios recast');
    // A signature over an image request never approves a video with the same prompt.
    const challenge = issueApprovalChallenge('user-1', TERMS);
    expect(verifyApprovalProof({ userId: 'user-1', terms: video, nonce: challenge.nonce, signature: sign(challenge.messageToSign), walletPubkey })).toBe('invalid_challenge');
    // Nor a video with other settings.
    const vc = issueApprovalChallenge('user-1', video);
    expect(verifyApprovalProof({ userId: 'user-1', terms: { ...video, paramsSha256: 'e'.repeat(64) }, nonce: vc.nonce, signature: sign(vc.messageToSign), walletPubkey })).toBe('invalid_challenge');
  });

  it('a signature for one saved key never approves the request for another key', () => {
    const terms = { ...TERMS, mode: 'account' as const, maxUsdCents: null, credentialSha256: 'b'.repeat(64) };
    const challenge = issueApprovalChallenge('user-1', terms);
    expect(verifyApprovalProof({ userId: 'user-1', terms: { ...terms, credentialSha256: 'c'.repeat(64) }, nonce: challenge.nonce, signature: sign(challenge.messageToSign), walletPubkey })).toBe('invalid_challenge');
  });

  it('accepts the linked wallet once, and refuses another wallet, other terms or a replay', () => {
    const challenge = issueApprovalChallenge('user-1', TERMS);
    expect(verifyApprovalProof({ userId: 'user-1', terms: TERMS, nonce: challenge.nonce, signature: sign(challenge.messageToSign, other.secretKey), walletPubkey })).toBe('invalid_signature');
    const second = issueApprovalChallenge('user-1', TERMS);
    expect(verifyApprovalProof({ userId: 'user-1', terms: { ...TERMS, maxUsdCents: 25 }, nonce: second.nonce, signature: sign(second.messageToSign), walletPubkey })).toBe('invalid_challenge');
    const third = issueApprovalChallenge('user-1', TERMS);
    const input = { userId: 'user-1', terms: TERMS, nonce: third.nonce, signature: sign(third.messageToSign), walletPubkey };
    expect(verifyApprovalProof(input)).toBe('ok');
    expect(verifyApprovalProof(input)).toBe('invalid_challenge');
  });

  it('a spend-rules challenge never approves a payment', () => {
    const challenge = issueSpendProofChallenge('user-1', VALUES);
    expect(verifyApprovalProof({ userId: 'user-1', terms: TERMS, nonce: challenge.nonce, signature: sign(challenge.messageToSign), walletPubkey })).toBe('invalid_challenge');
  });
});
