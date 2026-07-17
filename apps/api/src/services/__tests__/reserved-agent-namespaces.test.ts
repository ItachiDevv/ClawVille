/**
 * Reserved partner-namespace guard tests (Codex round-2 R2-1, 2026-06-12).
 *
 * The `hatcher:` agentId namespace must be globally reserved so a PUBLIC,
 * unsigned registration path can never create or mutate a row owned by the
 * partner-signed router. These cover the pure predicate that every public
 * writer to `openclaw_bots` calls.
 */

import { describe, it, expect } from 'bun:test';
import {
  HATCHER_AGENT_PREFIX,
  RESERVED_PARTNER_AGENT_PREFIXES,
  RESERVED_PARTNER_IDENTITY_TYPES,
  isReservedPartnerAgentId,
  isReservedPartnerIdentityType,
} from '../reserved-agent-namespaces';

describe('isReservedPartnerAgentId', () => {
  it('rejects a `hatcher:`-prefixed id (exact partner namespace)', () => {
    expect(isReservedPartnerAgentId('hatcher:abc')).toBe(true);
    expect(isReservedPartnerAgentId('hatcher:')).toBe(true);
    expect(isReservedPartnerAgentId(`${HATCHER_AGENT_PREFIX}any-raw-id`)).toBe(true);
  });

  it('allows ordinary public ids (no reserved prefix)', () => {
    expect(isReservedPartnerAgentId('agent-123')).toBe(false);
    expect(isReservedPartnerAgentId('my-openclaw-bot')).toBe(false);
    expect(isReservedPartnerAgentId('')).toBe(false);
  });

  it('allows the milady namespace (server-generated, NOT reserved for a signed partner)', () => {
    expect(isReservedPartnerAgentId('milady:xyz')).toBe(false);
  });

  it('is case-sensitive — only the exact lower-case partner literal is reserved', () => {
    // The partner router namespaces with the exact `hatcher:` literal, so an
    // upper-cased variant is a DIFFERENT (non-colliding) agentId and must not be
    // treated as the reserved space (it can never address the partner's rows).
    expect(isReservedPartnerAgentId('Hatcher:abc')).toBe(false);
    expect(isReservedPartnerAgentId('HATCHER:abc')).toBe(false);
  });

  it('does not match an id that merely CONTAINS the prefix mid-string', () => {
    expect(isReservedPartnerAgentId('not-hatcher:abc')).toBe(false);
    expect(isReservedPartnerAgentId('x-hatcher:abc')).toBe(false);
  });

  it('covers every entry in RESERVED_PARTNER_AGENT_PREFIXES', () => {
    for (const prefix of RESERVED_PARTNER_AGENT_PREFIXES) {
      expect(isReservedPartnerAgentId(`${prefix}whatever`)).toBe(true);
    }
  });
});

describe('isReservedPartnerIdentityType', () => {
  it('flags the `hatcher` identity type (the existing-row mutation guard key)', () => {
    expect(isReservedPartnerIdentityType('hatcher')).toBe(true);
  });

  it('allows non-partner identity types', () => {
    for (const t of ['milady', 'hermes', 'openclaw', 'custom']) {
      expect(isReservedPartnerIdentityType(t)).toBe(false);
    }
  });

  it('treats null/undefined as not reserved (fail-open is correct here — the agentId-prefix guard is the primary gate; this is defense in depth for a typed row)', () => {
    expect(isReservedPartnerIdentityType(null)).toBe(false);
    expect(isReservedPartnerIdentityType(undefined)).toBe(false);
  });

  it('covers every entry in RESERVED_PARTNER_IDENTITY_TYPES', () => {
    for (const t of RESERVED_PARTNER_IDENTITY_TYPES) {
      expect(isReservedPartnerIdentityType(t)).toBe(true);
    }
  });
});
