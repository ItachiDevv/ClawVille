const TRANSIENT_CONNECTION_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);

const TRANSIENT_CONNECTION_MESSAGE =
  /\b(?:CONNECTION_CLOSED|CONNECTION_ENDED|CONNECTION_DESTROYED|CONNECT_TIMEOUT)\b|\bwrite (?:ECONNRESET|EPIPE)\b/;

export function isTransientDbConnectionError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_CONNECTION_CODES.has(code)) {
      return true;
    }
  }

  return TRANSIENT_CONNECTION_MESSAGE.test(String(err));
}
