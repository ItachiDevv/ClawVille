import { beforeEach, describe, expect, it } from 'bun:test';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { isSpendPolicyRaise } from '@clawville/shared';
import {
  _resetSpendProofNoncesForTest,
  buildSpendRulesMessage,
  issueSpendProofChallenge,
  verifySpendProof,
} from '../spend-policy-proof';

const wallet = nacl.sign.keyPair();
const other = nacl.sign.keyPair();
const walletPubkey = bs58.encode(wallet.publicKey);
const VALUES = { dailyCapUsdCents: 500, perCallCapUsdCents: 50, allowedVendors: ['studios'] };

function sign(message: string, secretKey = wallet.secretKey): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), secretKey));
}

beforeEach(() => _resetSpendProofNoncesForTest());

describe('buildSpendRulesMessage', () => {
  it('names the account, each value and the nonce in readable text', () => {
    expect(buildSpendRulesMessage('user-1', VALUES, 'NONCE')).toBe(
      'ClawVille spend rules\naccount: user-1\ndaily cap: $5.00\nper-call cap: $0.50\npaid tools: studios\nnonce: NONCE',
    );
    expect(buildSpendRulesMessage('user-1', { dailyCapUsdCents: null, perCallCapUsdCents: 0, allowedVendors: [] }, 'N'))
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
  const none = { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [] as string[] };
  it('counts set-from-unset, a higher cap and an added vendor as a raise', () => {
    expect(isSpendPolicyRaise(none, { ...none, dailyCapUsdCents: 0 })).toBe(true);
    expect(isSpendPolicyRaise(VALUES, { ...VALUES, perCallCapUsdCents: 51 })).toBe(true);
    expect(isSpendPolicyRaise({ ...VALUES, allowedVendors: [] }, VALUES)).toBe(true);
  });
  it('counts equal, lower and cleared values as not a raise', () => {
    expect(isSpendPolicyRaise(VALUES, VALUES)).toBe(false);
    expect(isSpendPolicyRaise(VALUES, { ...VALUES, dailyCapUsdCents: 100 })).toBe(false);
    expect(isSpendPolicyRaise(VALUES, { dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [] })).toBe(false);
    expect(isSpendPolicyRaise(none, none)).toBe(false);
  });
});
