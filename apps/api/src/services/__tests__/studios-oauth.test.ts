/**
 * Studios sign-in, pure parts: PKCE S256 (RFC 7636 appendix B vector), the
 * Client ID Metadata Document per environment, and the redirect URLs.
 * The DB-backed flow is in routes/__tests__/studios-oauth-db.test.ts.
 */
// A placeholder only while the modules load (the db client reads it at import);
// removed after the imports so later suites in a shared `bun test` process
// do not see a database that does not exist.
const databaseUrlWasSet = !!process.env.DATABASE_URL;
if (!databaseUrlWasSet) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildStudiosClientMetadata,
  hashOAuthState,
  pkceChallengeS256,
  studiosClientId,
  studiosRedirectUri,
  studiosWebOrigin,
} from '../vendors/studios-oauth';

const savedCors = process.env.CORS_ORIGIN;
const savedWeb = process.env.WEB_ORIGIN;

afterEach(() => {
  if (savedCors === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = savedCors;
  if (savedWeb === undefined) delete process.env.WEB_ORIGIN;
  else process.env.WEB_ORIGIN = savedWeb;
});

describe('PKCE + state', () => {
  it('computes the RFC 7636 appendix B S256 challenge', () => {
    expect(pkceChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('hashes state to 64 hex characters', () => {
    expect(hashOAuthState('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('Client ID Metadata Document', () => {
  it('is exact on production: client_id is its own URL and the only redirect is the callback', () => {
    process.env.CORS_ORIGIN = 'https://clawville.world';
    expect(buildStudiosClientMetadata()).toEqual({
      client_id: 'https://api.clawville.world/.well-known/oauth-client/studios.json',
      client_name: 'ClawVille',
      redirect_uris: ['https://api.clawville.world/api/vendors/studios/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'studio offline_access',
    });
  });

  it('uses the staging API host on staging (never the production one)', () => {
    process.env.CORS_ORIGIN = 'https://staging.clawville.world';
    expect(studiosClientId()).toBe('https://api-staging.clawville.world/.well-known/oauth-client/studios.json');
    expect(studiosRedirectUri()).toBe('https://api-staging.clawville.world/api/vendors/studios/oauth/callback');
    expect(buildStudiosClientMetadata().redirect_uris).toEqual([studiosRedirectUri()]);
  });
});

describe('web origin for the post-sign-in redirect', () => {
  it('prefers WEB_ORIGIN, then the first CORS_ORIGIN entry, then production', () => {
    process.env.WEB_ORIGIN = 'https://staging.clawville.world/';
    process.env.CORS_ORIGIN = 'https://other.example';
    expect(studiosWebOrigin()).toBe('https://staging.clawville.world');
    delete process.env.WEB_ORIGIN;
    process.env.CORS_ORIGIN = 'https://staging.clawville.world, https://x.example';
    expect(studiosWebOrigin()).toBe('https://staging.clawville.world');
    delete process.env.CORS_ORIGIN;
    expect(studiosWebOrigin()).toBe('https://clawville.world');
  });
});

if (!databaseUrlWasSet) delete process.env.DATABASE_URL;
