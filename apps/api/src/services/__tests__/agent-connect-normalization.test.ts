import { describe, expect, test } from 'bun:test';
import {
  canonicalizePublicAgentIdentityType,
  isSessionRestorable,
  normalizeDirectAgentConnectRequest,
} from '../agent-session-config';

const GATEWAY = 'https://agent.example/v1';

describe('universal /connect tolerant normalization matrix', () => {
  test('legacy Milady signal keeps its exact fallback handle and hosted route', () => {
    const result = normalizeDirectAgentConnectRequest({ miladyAgentId: 'legacy-7' });
    expect(result).toMatchObject({
      agentId: 'milady:legacy-7',
      identityType: 'milady',
      ticketMiladyAgentId: 'legacy-7',
      cognition: { mode: 'hosted', protocol: 'nanoclaw', ignoredFields: [] },
      restorableFromRow: true,
    });
  });

  test('explicit Milady needs no legacy field and agentId wins when both exist', () => {
    expect(normalizeDirectAgentConnectRequest({
      agentId: 'stable-milady',
      explicitIdentityType: 'milady',
    })).toMatchObject({
      agentId: 'stable-milady',
      identityType: 'milady',
      cognition: { mode: 'hosted', protocol: 'nanoclaw', ignoredFields: [] },
      restorableFromRow: true,
    });
    expect(normalizeDirectAgentConnectRequest({
      agentId: 'preferred',
      miladyAgentId: 'legacy',
      explicitIdentityType: 'milady',
    }).agentId).toBe('preferred');
  });

  test('Milady accepts and deterministically reports every unused gateway field', () => {
    const result = normalizeDirectAgentConnectRequest({
      agentId: 'milady-gateway-shaped',
      explicitIdentityType: 'milady',
      gatewayUrl: GATEWAY,
      authToken: 'never-reflected',
      protocol: 'anthropic',
    });
    expect(result.gatewayUrl).toBeUndefined();
    expect(result.authToken).toBeUndefined();
    expect(result.cognition).toEqual({
      mode: 'hosted',
      protocol: 'nanoclaw',
      ignoredFields: ['gatewayUrl', 'authToken', 'protocol'],
    });
    expect(JSON.stringify(result)).not.toContain('never-reflected');
  });

  test('Hermes ignores caller gateway fields and follows either gate state', () => {
    const input = {
      agentId: 'hermes-1',
      explicitIdentityType: 'hermes' as const,
      gatewayUrl: GATEWAY,
      authToken: 'secret',
      protocol: 'anthropic' as const,
    };
    expect(normalizeDirectAgentConnectRequest(input, {
      hermesLocalGatewayEnabled: false,
    })).toMatchObject({
      cognition: {
        mode: 'pull',
        protocol: 'nanoclaw',
        ignoredFields: ['gatewayUrl', 'authToken', 'protocol'],
      },
      restorableFromRow: true,
    });
    expect(normalizeDirectAgentConnectRequest(input, {
      hermesLocalGatewayEnabled: true,
    })).toMatchObject({
      cognition: {
        mode: 'hosted',
        protocol: 'hermes-local',
        ignoredFields: ['gatewayUrl', 'authToken', 'protocol'],
      },
      restorableFromRow: true,
    });
  });

  test('OpenClaw with a real gateway keeps its declared wire and cannot restore', () => {
    expect(normalizeDirectAgentConnectRequest({
      agentId: 'openclaw-byo',
      explicitIdentityType: 'openclaw',
      gatewayUrl: GATEWAY,
      authToken: 'request-only',
      protocol: 'anthropic',
    })).toMatchObject({
      gatewayUrl: GATEWAY,
      authToken: 'request-only',
      storedProtocol: 'anthropic',
      cognition: { mode: 'gateway', protocol: 'anthropic', ignoredFields: [] },
      restorableFromRow: false,
    });
  });

  test('gateway-less OpenClaw accepts and restores under both gate states', () => {
    const input = { agentId: 'openclaw-hostless', explicitIdentityType: 'openclaw' as const };
    expect(normalizeDirectAgentConnectRequest(input, {
      openclawLocalGatewayEnabled: false,
    })).toMatchObject({
      cognition: { mode: 'pull', protocol: 'nanoclaw', ignoredFields: [] },
      restorableFromRow: true,
    });
    expect(normalizeDirectAgentConnectRequest(input, {
      openclawLocalGatewayEnabled: true,
    })).toMatchObject({
      cognition: { mode: 'hosted', protocol: 'openclaw-local', ignoredFields: [] },
      restorableFromRow: true,
    });
  });

  test('custom uses a real gateway or gateway-less pull from the same contract', () => {
    expect(normalizeDirectAgentConnectRequest({
      agentId: 'custom-byo',
      explicitIdentityType: 'custom',
      gatewayUrl: GATEWAY,
    })).toMatchObject({
      cognition: { mode: 'gateway', protocol: 'openai-compat', ignoredFields: [] },
      restorableFromRow: false,
    });
    expect(normalizeDirectAgentConnectRequest({
      agentId: 'custom-pull',
      explicitIdentityType: 'custom',
    })).toMatchObject({
      cognition: { mode: 'pull', protocol: 'nanoclaw', ignoredFields: [] },
      restorableFromRow: true,
    });
  });

  test('unknown bounded labels use the general custom adapter', () => {
    const identityType = canonicalizePublicAgentIdentityType('future_framework');
    expect(normalizeDirectAgentConnectRequest({
      agentId: 'future-1',
      explicitIdentityType: identityType,
    })).toMatchObject({
      identityType: 'custom',
      cognition: { mode: 'pull', protocol: 'nanoclaw', ignoredFields: [] },
      restorableFromRow: true,
    });
  });

  test('omitted identity defaults to custom with or without a gateway', () => {
    expect(normalizeDirectAgentConnectRequest({ agentId: 'omitted-pull' })).toMatchObject({
      identityType: 'custom',
      cognition: { mode: 'pull', protocol: 'nanoclaw', ignoredFields: [] },
      restorableFromRow: true,
    });
    expect(normalizeDirectAgentConnectRequest({
      agentId: 'omitted-gateway',
      gatewayUrl: GATEWAY,
    })).toMatchObject({
      identityType: 'custom',
      cognition: { mode: 'gateway', protocol: 'openai-compat', ignoredFields: [] },
      restorableFromRow: false,
    });
  });

  test('explicit nanoclaw wins over a supplied gateway and uses no secret', () => {
    const result = normalizeDirectAgentConnectRequest({
      agentId: 'explicit-pull',
      explicitIdentityType: 'custom',
      gatewayUrl: GATEWAY,
      authToken: 'ignored-secret',
      protocol: 'nanoclaw',
    });
    expect(result).toMatchObject({
      gatewayUrl: undefined,
      authToken: undefined,
      storedProtocol: 'nanoclaw',
      cognition: {
        mode: 'pull',
        protocol: 'nanoclaw',
        ignoredFields: ['gatewayUrl', 'authToken'],
      },
      restorableFromRow: true,
    });
    expect(result.cognition.ignoredFields).not.toContain('protocol');
  });

  test('explicit identity wins over the Milady signal without losing its fallback handle', () => {
    const result = normalizeDirectAgentConnectRequest({
      miladyAgentId: 'legacy-conflict',
      explicitIdentityType: 'hermes',
    }, { hermesLocalGatewayEnabled: false });
    expect(result).toMatchObject({
      agentId: 'milady:legacy-conflict',
      identityType: 'hermes',
      cognition: {
        mode: 'pull',
        protocol: 'nanoclaw',
        ignoredFields: ['miladyAgentId'],
      },
      restorableFromRow: true,
    });
    expect(result.ticketMiladyAgentId).toBeUndefined();
  });
});

describe('protected Hatcher restore classification', () => {
  test('complete hatcher-proxy config stays restorable; missing config stays rejected', () => {
    expect(isSessionRestorable('hatcher', 'hatcher-proxy', true)).toBe(true);
    expect(isSessionRestorable('hatcher', 'hatcher-proxy', false)).toBe(false);
  });
});
