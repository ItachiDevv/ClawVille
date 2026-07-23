import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative: string): string => readFileSync(
  fileURLToPath(new URL(relative, import.meta.url)),
  'utf8',
);

const topup = read('../../routes/ct-topup.ts');
const checkoutRoute = read('../../routes/x402-checkout.ts');
const checkout = read('../x402-checkout.ts');
const custodial = read('../custodial-x402.ts');

describe('B.1 inbound custodial activation wiring', () => {
  it('requires explicit custodial:true and rejects mixing it with a client-signed header', () => {
    expect(topup).toContain('custodial: z.literal(true).optional()');
    expect(checkoutRoute).toContain('custodial: z.literal(true).optional()');
    expect(topup).toContain("error: 'payment_mode_conflict'");
    expect(checkoutRoute).toContain("error: 'payment_mode_conflict'");
    expect(topup).toContain("if (!paymentHeader && !custodial)");
    expect(checkoutRoute).toContain("if (!paymentHeader && !parsed.data.custodial)");
  });

  it('loads only the middleware-bound avatar wallet and pins both inbound rails to the merchant', () => {
    expect(topup).toContain("eq(wallets.subjectId, avatarId)");
    expect(topup).toContain('payTo: config.merchantWalletPubkey');
    expect(checkout).toContain('loadBoundAvatarCustodialPayer(subject.avatarId)');
    expect(checkout).toContain('payTo: config.merchantWalletPubkey');
    expect(custodial).toContain('input.payTo !== merchantWalletPubkey');
    expect(custodial).toContain("direction: 'inbound'");
  });

  it('OPEN circuit preparation is Meridian-only and direct Meridian never records a PayAI failure', () => {
    expect(topup).toContain('if (!permit)');
    expect(topup).toContain('prepareInboundMeridianPayment(input)');
    expect(topup).toContain('skipPayAi: true');
    expect(topup).toContain('if (attempt.permit && outcome.payAi.attempted)');
    expect(topup).toContain('outcome.payAi.providerFailure');
  });

  it('both capture paths carry exact fee accounting into their durable global receipt', () => {
    expect(topup).toContain('x402SettlementAccounting: accountingMetadata(accounting)');
    expect(topup).toContain('netUsdcAtomic: capturedAccounting.netUsdcAtomic');
    expect(checkout).toContain('x402SettlementAccounting: accountingMetadata(accounting)');
    expect(checkout).toContain('netUsdcAtomic: accounting.netUsdcAtomic');
    expect(checkout).toContain('netUsdcAtomic: capturedAccounting.netUsdcAtomic');
  });

  it('does not alter or advertise a second accepts entry', () => {
    expect(topup).not.toContain('accepts.push');
    expect(checkout).not.toContain('accepts.push');
    expect(checkoutRoute).not.toContain('PROTOCOL_VERSION');
  });
});
