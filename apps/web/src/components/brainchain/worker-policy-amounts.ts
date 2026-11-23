/** Exact decimal conversion. Owner limits must never round up or down. */
export function parsePolicyAmount(value: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new Error('Enter a non-negative decimal amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  return BigInt(whole + fraction.padEnd(decimals, '0')).toString();
}

export function formatPolicyAmount(value: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return 'Invalid amount';
  const padded = value.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
