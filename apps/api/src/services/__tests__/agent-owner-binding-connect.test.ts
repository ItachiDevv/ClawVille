import { describe, expect, test } from 'bun:test';
import {
  canBindAgentOwner,
  buildReturningIdentityDisclosure,
  connectionTokenClaimError,
  connectRequiresOwnerCredential,
  connectTokenOwnedByOtherAccount,
  AGENT_OWNED_BY_OTHER_ACCOUNT_BODY,
  OWNER_CREDENTIAL_REQUIRED_BODY,
  planConnectOwnerBinding,
  resolvePersistedConnectOwnerProof,
} from '../agent-owner-binding';

describe('connect owner binding', () => {
  test('returning identity disclosure is nonsecret and actionable', () => {
    const disclosure = buildReturningIdentityDisclosure('user-a', 'public-a');
    expect(disclosure).toMatchObject({
      userId: 'user-a',
      publicKey: 'public-a',
      isFirstTime: false,
      secretIncluded: false,
      secretIssuedPreviously: true,
    });
    expect(disclosure.recovery).toContain('before this session lapses');
    expect(disclosure).not.toHaveProperty('secretKey');
  });

  test('connection-token claims require the stable agentId before reservation', () => {
    expect(connectionTokenClaimError({ connectionToken: 'ct-secret' })).toBe(
      'agentId required when claiming a connection token',
    );
    expect(connectionTokenClaimError({
      connectionToken: 'ct-secret',
      agentId: 'stable-agent',
    })).toBeNull();
    expect(connectionTokenClaimError({})).toBeNull();
  });

  test('bare agentId knowledge never proves ownership or ledger access', () => {
    expect(planConnectOwnerBinding({
      existingUserId: 'owner-a',
      tokenUserId: null,
      identityKeyUserId: null,
      activeAvatarId: 'avatar-a',
    })).toEqual({
      persistedUserId: 'owner-a',
      identityMismatch: false,
      boundUserId: null,
      ledgerCapable: false,
      ownershipChanged: false,
    });
  });

  test('a credentialless connect to an owned row requires an owner credential', () => {
    // Owned row, bare agentId (no token, no resolved identityKey): refused.
    expect(connectRequiresOwnerCredential({
      existingUserId: 'owner-a',
      tokenUserId: null,
      identityKeyUserId: null,
    })).toBe(true);
    // Unowned row keeps the anonymous model: no credential exists to demand.
    expect(connectRequiresOwnerCredential({
      existingUserId: null,
      tokenUserId: null,
      identityKeyUserId: null,
    })).toBe(false);
    // An owned connection token is a credential, so this check lets it pass;
    // a token from ANOTHER account is refused by connectTokenOwnedByOtherAccount.
    expect(connectRequiresOwnerCredential({
      existingUserId: 'owner-a',
      tokenUserId: 'owner-token',
      identityKeyUserId: null,
    })).toBe(false);
    // A resolved identityKey is a credential: the same owner passes, and a
    // different owner stays on the OWNER_BIND_CONFLICT path, not this refusal.
    expect(connectRequiresOwnerCredential({
      existingUserId: 'owner-a',
      tokenUserId: null,
      identityKeyUserId: 'owner-a',
    })).toBe(false);
    expect(connectRequiresOwnerCredential({
      existingUserId: 'owner-a',
      tokenUserId: null,
      identityKeyUserId: 'owner-b',
    })).toBe(false);
    expect(OWNER_CREDENTIAL_REQUIRED_BODY).toEqual({
      error: 'This agentId already has an owner. Connect with its identityKey or use the signed /api/agent/reconnect.',
      code: 'owner_credential_required',
    });
  });

  test('explicit identity heals an unbound row but needs an active avatar for ledger', () => {
    expect(planConnectOwnerBinding({
      existingUserId: null,
      tokenUserId: null,
      identityKeyUserId: 'owner-b',
      activeAvatarId: null,
    })).toEqual({
      persistedUserId: 'owner-b',
      identityMismatch: false,
      boundUserId: 'owner-b',
      ledgerCapable: false,
      ownershipChanged: true,
    });

    expect(planConnectOwnerBinding({
      existingUserId: 'owner-b',
      tokenUserId: null,
      identityKeyUserId: 'owner-b',
      activeAvatarId: 'avatar-b',
    }).ledgerCapable).toBe(true);
  });

  test('a conflicting live owner wins a stale-read identity race', () => {
    // Request B may have observed NULL, but the DB conditional claim must use
    // the current owner. Once request A has claimed the row, B cannot bind.
    expect(canBindAgentOwner(null, 'owner-b')).toBe(true);
    expect(canBindAgentOwner('owner-a', 'owner-b')).toBe(false);

    expect(planConnectOwnerBinding({
      existingUserId: 'owner-a',
      tokenUserId: null,
      identityKeyUserId: 'owner-b',
      activeAvatarId: 'avatar-b',
    })).toEqual({
      persistedUserId: 'owner-a',
      identityMismatch: true,
      boundUserId: null,
      ledgerCapable: false,
      ownershipChanged: false,
    });
  });

  test('a connection token never moves a row owned by another account', () => {
    // Security 2026-09-30: the token used to rewrite owner-a's row to the
    // token's user (persistedUserId 'owner-token', ownershipChanged true).
    expect(planConnectOwnerBinding({
      existingUserId: 'owner-a',
      tokenUserId: 'owner-token',
      identityKeyUserId: 'owner-key',
      activeAvatarId: 'avatar-token',
    })).toEqual({
      persistedUserId: 'owner-a',
      identityMismatch: true,
      boundUserId: null,
      ledgerCapable: false,
      ownershipChanged: false,
    });
  });

  test('a connection token binds an unowned row or proves its own owner', () => {
    expect(planConnectOwnerBinding({
      existingUserId: null,
      tokenUserId: 'owner-token',
      identityKeyUserId: null,
      activeAvatarId: 'avatar-token',
    })).toEqual({
      persistedUserId: 'owner-token',
      identityMismatch: false,
      boundUserId: 'owner-token',
      ledgerCapable: true,
      ownershipChanged: true,
    });
    expect(planConnectOwnerBinding({
      existingUserId: 'owner-token',
      tokenUserId: 'owner-token',
      identityKeyUserId: null,
      activeAvatarId: 'avatar-token',
    })).toEqual({
      persistedUserId: 'owner-token',
      identityMismatch: false,
      boundUserId: 'owner-token',
      ledgerCapable: true,
      ownershipChanged: false,
    });
  });

  test('connectTokenOwnedByOtherAccount flags only a token for a different owner', () => {
    expect(connectTokenOwnedByOtherAccount({ existingUserId: 'owner-a', tokenUserId: 'owner-b' })).toBe(true);
    expect(connectTokenOwnedByOtherAccount({ existingUserId: 'owner-a', tokenUserId: 'owner-a' })).toBe(false);
    expect(connectTokenOwnedByOtherAccount({ existingUserId: null, tokenUserId: 'owner-b' })).toBe(false);
    // No token user (no token, or a public front-door token): not this rule.
    expect(connectTokenOwnedByOtherAccount({ existingUserId: 'owner-a', tokenUserId: null })).toBe(false);
    expect(connectTokenOwnedByOtherAccount({ existingUserId: null, tokenUserId: null })).toBe(false);
    expect(AGENT_OWNED_BY_OTHER_ACCOUNT_BODY).toEqual({
      error: 'This agentId belongs to another account. Connect it from that account, or use its identityKey or the signed /api/agent/reconnect.',
      code: 'agent_owned_by_other_account',
    });
    expect(Object.isFrozen(AGENT_OWNED_BY_OTHER_ACCOUNT_BODY)).toBe(true);
  });

  test.each([
    ['connection token', 'connection-token', 'owner-a', 'owner-a', true],
    ['explicit identity', 'explicit-identity', 'owner-a', 'owner-a', true],
    ['Milady inferred', 'milady-inferred', null, 'owner-a', false],
    ['gateway inferred', 'gateway-inferred', null, 'owner-a', false],
    ['conflicting owner', 'explicit-identity', 'owner-b', 'owner-a', false],
    ['anonymous', 'anonymous', null, null, false],
  ] as const)(
    '%s wallet authorization is derived from the persisted bind',
    (_label, source, candidateUserId, persistedUserId, ownerProven) => {
      expect(resolvePersistedConnectOwnerProof({
        source,
        candidateUserId,
        persistedUserId,
        avatarId: 'avatar-a',
      })).toEqual({
        ownerProven,
        boundUserId: ownerProven ? persistedUserId : null,
        ledgerCapable: ownerProven,
      });
    },
  );
});
