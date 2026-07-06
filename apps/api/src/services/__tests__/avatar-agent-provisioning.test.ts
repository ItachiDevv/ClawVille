/**
 * P2 Slice A/B unit tests — avatar-agent provisioning service
 * (`avatar-agent-provisioning.ts`). DB-free: exercises the pure seams only
 * (name derivation, suffix candidates, the signup defaults, the fail-soft
 * wrapper, the pending-mode predicate, and the moved-verbatim
 * calculateAvatarStats/buildCharacterConfig helpers). The DB-touching
 * `provisionAvatarAgent` path is covered by the staging e2e signup proof
 * (plan doc "Gates").
 *
 * Run: `bun test avatar-agent-provisioning`.
 */

import { describe, test, expect } from 'bun:test';
import {
  AVATAR_ARCHETYPES,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  getAgentModel,
} from '@clawville/shared';
import {
  deriveSignupAvatarNameBase,
  suffixNameCandidate,
  runProvisioningFailSoft,
  isAgentProvisioningPending,
  buildSignupProvisionParams,
  calculateAvatarStats,
  buildCharacterConfig,
  SIGNUP_PROVISION_ARCHETYPE,
  AvatarNameTakenError,
} from '../avatar-agent-provisioning';

// The binding constraint: the provisioning tx initializes users.username from
// the avatar name in the SAME transaction, so every candidate MUST satisfy
// the users_username_format CHECK.
const USERNAME_FORMAT = /^[a-zA-Z0-9_]{3,20}$/;

describe('deriveSignupAvatarNameBase', () => {
  test('prefers the signup name field over the email local-part', () => {
    expect(deriveSignupAvatarNameBase('Itachi', 'someone@example.com')).toBe('Itachi');
  });

  test('falls back to the email local-part when name is missing/empty', () => {
    expect(deriveSignupAvatarNameBase(undefined, '444hoodie@gmail.com')).toBe('444hoodie');
    expect(deriveSignupAvatarNameBase('', '444hoodie@gmail.com')).toBe('444hoodie');
    expect(deriveSignupAvatarNameBase('   ', '444hoodie@gmail.com')).toBe('444hoodie');
    expect(deriveSignupAvatarNameBase(null, '444hoodie@gmail.com')).toBe('444hoodie');
  });

  test('sanitizes to the users_username_format alphabet', () => {
    expect(deriveSignupAvatarNameBase('John Smith!', 'x@y.com')).toBe('JohnSmith');
    expect(deriveSignupAvatarNameBase(undefined, 'first.last+tag@work.io')).toBe('firstlasttag');
    expect(deriveSignupAvatarNameBase('agent_007', 'x@y.com')).toBe('agent_007');
  });

  test('clamps to 20 chars', () => {
    const long = 'a'.repeat(40);
    const base = deriveSignupAvatarNameBase(long, 'x@y.com');
    expect(base.length).toBe(20);
    expect(base).toMatch(USERNAME_FORMAT);
  });

  test("falls back to 'Agent' when the sanitized base is under 3 chars", () => {
    expect(deriveSignupAvatarNameBase('!!', 'a@b.com')).toBe('Agent');
    expect(deriveSignupAvatarNameBase(undefined, 'ab@x.com')).toBe('Agent');
    expect(deriveSignupAvatarNameBase(undefined, '@x.com')).toBe('Agent');
  });

  test('every derivation satisfies the username CHECK format', () => {
    const cases: Array<[string | undefined, string]> = [
      ['Itachi', 'x@y.com'],
      [undefined, '444hoodie@gmail.com'],
      ['名前', 'kanji@x.com'], // fully non-latin → fallback
      ['a b', 'ab@x.com'], // sanitizes to 'ab' → too short → fallback
      ['x'.repeat(100), 'x@y.com'],
    ];
    for (const [name, email] of cases) {
      expect(deriveSignupAvatarNameBase(name, email)).toMatch(USERNAME_FORMAT);
    }
  });
});

describe('suffixNameCandidate', () => {
  test('appends a 4-digit suffix and stays within 20 chars', () => {
    const candidate = suffixNameCandidate('Itachi', () => 0);
    expect(candidate).toBe('Itachi1000');
    const maxed = suffixNameCandidate('a'.repeat(20), () => 0.999999);
    expect(maxed.length).toBeLessThanOrEqual(20);
    expect(maxed).toMatch(USERNAME_FORMAT);
  });

  test('suffix stays in 1000..9999 across the random range', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const candidate = suffixNameCandidate('Base', () => r);
      const suffix = Number(candidate.slice('Base'.length));
      expect(suffix).toBeGreaterThanOrEqual(1000);
      expect(suffix).toBeLessThanOrEqual(9999);
    }
  });

  test('distinct random draws give distinct candidates (retry actually retries)', () => {
    const a = suffixNameCandidate('Base', () => 0.1);
    const b = suffixNameCandidate('Base', () => 0.9);
    expect(a).not.toBe(b);
  });
});

describe('runProvisioningFailSoft', () => {
  test('passes the resolved value through', async () => {
    const out = await runProvisioningFailSoft('test', async () => 42);
    expect(out).toBe(42);
  });

  test('swallows a throw and returns null (signup must still 200)', async () => {
    const out = await runProvisioningFailSoft('test', async () => {
      throw new Error('provisioning exploded');
    });
    expect(out).toBeNull();
  });

  test('swallows a typed AvatarNameTakenError too', async () => {
    const out = await runProvisioningFailSoft('test', async () => {
      throw new AvatarNameTakenError('Taken', true);
    });
    expect(out).toBeNull();
  });
});

describe('isAgentProvisioningPending (Slice B predicate)', () => {
  test('guests are NEVER pending regardless of avatar state', () => {
    expect(isAgentProvisioningPending({ isGuest: true, hasAvatar: false, hasPlatformAgent: false })).toBe(false);
    expect(isAgentProvisioningPending({ isGuest: true, hasAvatar: true, hasPlatformAgent: false })).toBe(false);
    expect(isAgentProvisioningPending({ isGuest: true, hasAvatar: true, hasPlatformAgent: true })).toBe(false);
  });

  test('non-guest without an avatar is pending', () => {
    expect(isAgentProvisioningPending({ isGuest: false, hasAvatar: false, hasPlatformAgent: false })).toBe(true);
  });

  test('non-guest with an avatar but no platform agent is pending', () => {
    expect(isAgentProvisioningPending({ isGuest: false, hasAvatar: true, hasPlatformAgent: false })).toBe(true);
  });

  test('non-guest with avatar + platform agent is NOT pending', () => {
    expect(isAgentProvisioningPending({ isGuest: false, hasAvatar: true, hasPlatformAgent: true })).toBe(false);
  });
});

describe('buildSignupProvisionParams (D4 defaults)', () => {
  test('the (modelKey, agentCategory, harness) triple is self-consistent', () => {
    const params = buildSignupProvisionParams('Tester');
    const model = getAgentModel(params.modelKey);
    expect(model).toBeTruthy();
    // The authed POST /api/avatars route derives agentCategory from the model
    // registry when omitted — signup defaults must match that derivation, NOT
    // the standalone DEFAULT_AGENT_CATEGORY ('openclaw', which mismatches a
    // milady model and would fail the route's cross-validation).
    expect(params.agentCategory).toBe(model!.category);
  });

  test('harness is a hosted harness so /me/agent-session reports mode hosted', () => {
    const params = buildSignupProvisionParams('Tester');
    expect(['milady', 'hermes']).toContain(params.harness);
  });

  test('archetype exists in the registry (curious-scholar, the /join precedent)', () => {
    expect(SIGNUP_PROVISION_ARCHETYPE).toBe('curious-scholar');
    const archetype = AVATAR_ARCHETYPES.find((a) => a.id === SIGNUP_PROVISION_ARCHETYPE);
    expect(archetype).toBeTruthy();
  });

  test('species/color/gender/personality align with the web milady→legacy-species mapping', () => {
    const params = buildSignupProvisionParams('Tester');
    // 'fox' matches MODEL_KEY_TO_LEGACY_SPECIES[milady_official_1] on the web
    // (agent-model-registry.ts) so the first unchanged customize submit sends
    // no reconciling species PATCH.
    expect(params.species).toBe('fox');
    expect(params.color).toBe('blue');
    expect(params.gender).toBe('male');
    expect(params.personality).toEqual({
      habitat: 'sea',
      hobby: 'reading-and-learning',
      greeting: 'wave-hello',
    });
  });
});

describe('calculateAvatarStats (moved verbatim from routes/avatars.ts)', () => {
  test('signup default personality resolves to the create-route formula values', () => {
    // sea {2,3,5} + reading-and-learning {0,2,3} + wave-hello {1,2,2}
    expect(
      calculateAvatarStats({ habitat: 'sea', hobby: 'reading-and-learning', greeting: 'wave-hello' }),
    ).toEqual({ strength: 3, defence: 7, movement: 10 });
  });

  test('a second known combination stays stable', () => {
    // cave {5,5,0} + battling {4,1,0} + roar {4,1,0}
    expect(
      calculateAvatarStats({ habitat: 'cave', hobby: 'battling', greeting: 'roar' }),
    ).toEqual({ strength: 13, defence: 7, movement: 0 });
  });
});

describe('buildCharacterConfig (moved verbatim from routes/avatars.ts)', () => {
  test('system prompt embeds name + model label; knowledge = archetype + orientation', () => {
    const config = buildCharacterConfig(
      'curious-scholar' as never,
      'Tester',
      'Milady Official 1',
      null,
    );
    expect(config.system).toContain('You are Tester, a Milady Official 1');
    expect(config.system).not.toContain('focus on learning');
    const archetype = AVATAR_ARCHETYPES.find((a) => a.id === 'curious-scholar')!;
    expect(config.knowledge).toEqual([...archetype.knowledge, ...CLAWVILLE_ORIENTATION_KNOWLEDGE]);
  });

  test('learningFocus injects the focus line', () => {
    const config = buildCharacterConfig(
      'curious-scholar' as never,
      'Tester',
      'Milady Official 1',
      'cron jobs',
    );
    expect(config.system).toContain('focus on learning: "cron jobs"');
  });

  test('unknown archetype throws loudly', () => {
    expect(() =>
      buildCharacterConfig('not-a-real-archetype' as never, 'X', 'Y', null),
    ).toThrow('Unknown archetype');
  });
});
