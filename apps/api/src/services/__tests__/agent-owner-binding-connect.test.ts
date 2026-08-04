import { describe, expect, test } from 'bun:test';
import {
  canBindAgentOwner,
  buildReturningIdentityDisclosure,
  connectionTokenClaimError,
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

  test('owned connection token retains intentional precedence', () => {
    expect(planConnectOwnerBinding({
      existingUserId: 'owner-a',
      tokenUserId: 'owner-token',
      identityKeyUserId: 'owner-key',
      activeAvatarId: 'avatar-token',
    })).toEqual({
      persistedUserId: 'owner-token',
      identityMismatch: false,
      boundUserId: 'owner-token',
      ledgerCapable: true,
      ownershipChanged: true,
    });
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
