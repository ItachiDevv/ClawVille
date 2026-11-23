/** Decimal conversion preserves atomic units; no floating-point money arithmetic. */
export function formatAtomic(value: string, decimals: number): string {
  if (!/^(0|[1-9]\d*)$/.test(value)) return 'Unavailable';
  const padded = value.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`;
}

