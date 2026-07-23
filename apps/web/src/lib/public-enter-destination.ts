const CONNECT_TICKET_PATTERN = /^sess-[1-9A-HJ-NP-Za-km-z]{16,22}$/;

/**
 * Reduce a server-provided public-connect handoff to the only navigation the
 * browser may perform: this web origin's one-use `/enter?t=` route.
 *
 * The returned relative path deliberately drops the supplied origin rather
 * than echoing it. This keeps both the front door and the in-game modal on the
 * same strict allowlist and prevents an API response from becoming an open
 * redirect.
 */
export function resolvePublicEnterDestination(
  enterUrl: string,
  origin: string,
): string | null {
  try {
    const url = new URL(enterUrl, origin);
    const queryKeys = Array.from(url.searchParams.keys());
    const ticketValues = url.searchParams.getAll('t');

    if (
      url.origin !== origin ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/enter' ||
      url.hash !== '' ||
      queryKeys.length !== 1 ||
      queryKeys[0] !== 't' ||
      ticketValues.length !== 1 ||
      !CONNECT_TICKET_PATTERN.test(ticketValues[0])
    ) {
      return null;
    }

    return `/enter?t=${encodeURIComponent(ticketValues[0])}`;
  } catch {
    return null;
  }
}
