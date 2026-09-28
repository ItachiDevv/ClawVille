import { describe, expect, test } from 'bun:test';
import { getSiteUrl } from './site-url';

describe('getSiteUrl', () => {
  test.each([
    ['https://api-staging.clawville.world/v1', 'https://staging.clawville.world/'],
    ['https://api.clawville.world', 'https://clawville.world/'],
    ['http://localhost:4000', 'https://clawville.world/'],
    ['https://api-staging.clawville.world.evil.test', 'https://clawville.world/'],
    ['invalid', 'https://clawville.world/'],
    [undefined, 'https://clawville.world/'],
  ])('%s maps to %s', (apiUrl, expected) => {
    expect(getSiteUrl(apiUrl).href).toBe(expected);
  });
});
