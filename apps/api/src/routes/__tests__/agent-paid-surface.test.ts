import { describe, expect, it } from 'bun:test';
import { CLAWVILLE_GAME_TOOLS } from '@clawville/shared';
import { agentV2Routes, getExpertConsultDeliveryStatus } from '../agent-v2';
import { buildX402Routes, type X402Config } from '../../services/x402-config';
import { buildProtocolManual, PROTOCOL_VERSION } from '../../services/skill-protocol';

const config: X402Config = {
  enabled: true,
  facilitatorPreset: 'payai',
  facilitatorUrlExplicit: false,
  facilitatorUrl: 'https://facilitator.payai.network',
  payaiApiKeyId: '',
  payaiApiKeySecret: '',
  merchantWalletPubkey: '79sH9jtT7EpWLCemadFZQb7sD1b6rCqkwTtSxDCViLLE',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
};

describe('agent paid surfaces', () => {
  it('declares exact x402 prices for both real offerings', () => {
    const routes = buildX402Routes(config) as Record<
      string,
      { accepts: { price: string; payTo: string } }
    >;

    expect(routes['POST /api/v2/agent/expert-consult']?.accepts.price).toBe('$0.05');
    expect(routes['GET /api/v2/agent/analytics/:agentId']?.accepts.price).toBe('$0.01');
    expect(routes['POST /api/v2/agent/expert-consult']?.accepts.payTo).toBe(
      config.merchantWalletPubkey,
    );
  });

  it('registers payment and both paid offerings in the universal tool bundle', () => {
    const names = CLAWVILLE_GAME_TOOLS.map((tool) => tool.name);
    expect(names).toContain('clawville_pay_agent');
    expect(names).toContain('clawville_paid_expert_consult');
    expect(names).toContain('clawville_paid_agent_analytics');
    expect(names).toContain('clawville_redeem_earned');
  });

  it('publishes the additive commerce and default-off exit contract', () => {
    const manual = buildProtocolManual('https://api.example.test');
    expect(PROTOCOL_VERSION).toBe(42);
    expect(manual).toContain('POST https://api.example.test/api/agent-pay');
    expect(manual).toContain('Idempotency-Key');
    expect(manual).toContain('/api/v2/agent/expert-consult');
    expect(manual).toContain('/api/v2/agent/analytics/:agentId');
    expect(manual).toContain('POST https://api.example.test/api/tokenomics/redeem');
    expect(manual).toContain('GET https://api.example.test/api/tokenomics/redeem/:id');
    expect(manual).toContain('redeem_disabled');
    expect(manual).toContain('4.44%');
  });

  it('rejects malformed expert requests before service execution', async () => {
    const response = await agentV2Routes.request('/expert-consult', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('makes an empty expert result non-settleable', () => {
    expect(getExpertConsultDeliveryStatus(0)).toBe(503);
    expect(getExpertConsultDeliveryStatus(1)).toBe(200);
  });

  it('rejects an overlong analytics id before querying the leaderboard', async () => {
    const response = await agentV2Routes.request(`/analytics/${'a'.repeat(161)}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_agent_id' });
  });
});
