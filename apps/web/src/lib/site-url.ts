const productionUrl = new URL('https://clawville.world');

export function getSiteUrl(apiUrl: string | undefined): URL {
  if (!apiUrl) return productionUrl;

  try {
    const host = new URL(apiUrl).hostname;
    if (host === 'api-staging.clawville.world') return new URL('https://staging.clawville.world');
    if (host === 'api.clawville.world') return productionUrl;
  } catch {
    // Local or malformed API URLs use the production site origin.
  }

  return productionUrl;
}
