import { describe, expect, test } from 'bun:test';
import {
  buildAvatarSessionConfig,
  isRowRestorableFromFacts,
  isSessionRestorable,
} from '../agent-session-config';
import {
  hasCompleteHatcherProxyConfig,
  isPublicRestoreRowRestorable,
  resolveRestoredSessionAuthorization,
} from '../agent-session-restore';

describe('agent-session restore protected contract', () => {
  test('Hatcher proxy restore keeps the complete encrypted-envelope gate byte-identical', () => {
    const complete = {
      proxyUrl: 'https://proxy.hatcher.example/v1',
      proxyTokenEnc: 'encrypted-token',
      proxyTokenIv: '0123456789abcdef',
      proxyTokenTag: 'fedcba9876543210',
    };

    expect(hasCompleteHatcherProxyConfig(complete)).toBe(true);
    expect(isSessionRestorable('hatcher', 'hatcher-proxy', true)).toBe(true);

    for (const missing of Object.keys(complete) as Array<keyof typeof complete>) {
      expect(hasCompleteHatcherProxyConfig({ ...complete, [missing]: null })).toBe(false);
    }
    expect(isSessionRestorable('hatcher', 'hatcher-proxy', false)).toBe(false);
  });

  test('Hatcher proxy restore preserves its historical user-bound ledger status and config', () => {
    const authorization = resolveRestoredSessionAuthorization(
      'hatcher-proxy',
      'user-1',
    );
    expect(authorization).toEqual({
      ledgerCapable: true,
      boundUserId: 'user-1',
    });
    expect(resolveRestoredSessionAuthorization('hatcher-proxy', null)).toEqual({
      ledgerCapable: false,
      boundUserId: null,
    });

    const config = buildAvatarSessionConfig({
      mode: 'avatar',
      agentId: 'hatcher:alpha',
      sessionId: 'hat-session',
      identityType: 'hatcher',
      storedProtocol: 'hatcher-proxy',
      autonomyMode: 'server-managed',
      name: 'Alpha',
      species: null,
      color: 0x123456,
      stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
      homeX: 11264,
      homeY: 11264,
      patrolRadius: 100,
      personality: 'steady',
      ...authorization,
      avatarId: 'avatar-1',
      protocolOverride: 'hatcher-proxy',
    });

    expect(config).toEqual({
      agentId: 'hatcher:alpha',
      sessionId: 'hat-session',
      sessionKey: 'hat-session',
      gatewayUrl: 'http://localhost:0',
      authToken: '',
      protocol: 'hatcher-proxy',
      mode: 'avatar',
      autonomyMode: 'server-managed',
      name: 'Alpha',
      species: 'phanes',
      color: 0x123456,
      stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
      homeX: 11264,
      homeY: 11264,
      patrolRadius: 100,
      personality: 'steady',
      ledgerCapable: true,
      boundUserId: 'user-1',
      avatarId: 'avatar-1',
    });
  });

  test('public no-gateway restore is fact-based and noncanonical rows fail closed', () => {
    for (const identityType of ['milady', 'hermes', 'openclaw', 'custom']) {
      expect(isRowRestorableFromFacts(identityType, null, false, 'openai-compat')).toBe(true);
      expect(isRowRestorableFromFacts(identityType, null, true, 'openai-compat')).toBe(true);
    }

    for (const identityType of ['openclaw', 'custom']) {
      expect(
        isRowRestorableFromFacts(
          identityType,
          'https://caller-gateway.example/v1',
          false,
          'openai-compat',
        ),
      ).toBe(false);
    }

    for (const identityType of ['some-future-framework', 'constructor']) {
      expect(isRowRestorableFromFacts(identityType, null, false, 'openai-compat')).toBe(false);
      expect(isRowRestorableFromFacts(identityType, null, false, 'nanoclaw')).toBe(true);
    }

    // The partner proxy stays outside the public fact predicate.
    expect(isRowRestorableFromFacts('hatcher', null, false, 'hatcher-proxy')).toBe(false);
  });

  test('the production restore seam honors native and explicit-pull precedence over stale URLs', () => {
    for (const identityType of ['milady', 'hermes']) {
      expect(isPublicRestoreRowRestorable({
        identityType,
        gatewayUrl: 'https://stale-native.example/v1',
        protocol: 'openai-compat',
      })).toBe(true);
    }
    for (const identityType of ['openclaw', 'custom', 'some-future-framework']) {
      expect(isPublicRestoreRowRestorable({
        identityType,
        gatewayUrl: 'https://stale-pull.example/v1',
        protocol: 'nanoclaw',
      })).toBe(true);
    }
    expect(isPublicRestoreRowRestorable({
      identityType: 'openclaw',
      gatewayUrl: 'https://real-gateway.example/v1',
      protocol: 'openai-compat',
    })).toBe(false);
  });

  test('restored public sessions never gain ledger authority and keep row binding only', () => {
    for (const protocol of [
      'nanoclaw',
      'hermes-local',
      'openclaw-local',
      'openai-compat',
      'anthropic',
      'custom-webhook',
    ]) {
      expect(resolveRestoredSessionAuthorization(protocol, null)).toEqual({
        ledgerCapable: false,
        boundUserId: null,
      });
      expect(resolveRestoredSessionAuthorization(protocol, 'user-1')).toEqual({
        ledgerCapable: false,
        boundUserId: 'user-1',
      });
    }
  });
});
