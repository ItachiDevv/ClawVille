import { describe, expect, test } from 'bun:test';
import {
  CLAWVILLE_GAME_TOOLS,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  DECISION_SCOPE,
  TRADE_DAILY_SCORED_CAP,
  TRADE_DEX_PROGRAMS,
  TRADE_MINTS,
  TRADE_REFUSAL_CODES,
  TRADE_REFUSAL_COPY,
  TRADE_TIER_MULTIPLIER,
  TRADE_TIER_WEIGHTS,
  TRADE_UNSCORED_REASONS,
  TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT,
  isTradeRefusalCode,
  isTradeUnscoredReason,
} from '@clawville/shared';
import { buildProtocolManual, PROTOCOL_VERSION } from '../skill-protocol';

describe('Trading Floor frozen constants', () => {
  // Sweep this pin by ASSERTION, never by grepping the old number: the title
  // sat stale at 61 through the v62, v63 and v64 bumps because only the
  // assertion below was updated.
  test('pins the current protocol version and the multiplier contracts', () => {
    expect(PROTOCOL_VERSION).toBe(65);
    expect(TRADE_TIER_WEIGHTS).toEqual({ base: 20, clv: 30, ansem: 40 });
    expect(TRADE_TIER_MULTIPLIER).toEqual({ base: 1, clv: 1.5, ansem: 2 });
    expect(TRADE_DAILY_SCORED_CAP).toBe(20);
  });

  test('pins the approved mints and DEX programs', () => {
    expect(TRADE_MINTS).toEqual({
      ANSEM: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
      CLAWVILLE: 'Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA',
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      WSOL: 'So11111111111111111111111111111111111111112',
    });
    expect(TRADE_DEX_PROGRAMS).toEqual({
      jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    });
  });

  test('pins every objective USDC share floor from the final specification', () => {
    expect(TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT).toEqual({
      'momentum-board': 0,
      'ansem-clawville-dca': 10,
      'sol-usdc-mean-reversion': 20,
      'intel-signal-follower': 10,
      'conservative-rebalancer': 60,
    });
  });

  test('derives both wire guards from their runtime arrays', () => {
    expect(TRADE_REFUSAL_CODES).toHaveLength(39);
    for (const code of TRADE_REFUSAL_CODES) expect(isTradeRefusalCode(code)).toBe(true);
    for (const reason of TRADE_UNSCORED_REASONS) expect(isTradeUnscoredReason(reason)).toBe(true);
    for (const value of [null, undefined, '', 7, 'daily_cap_reached']) {
      expect(isTradeRefusalCode(value)).toBe(false);
      expect(isTradeUnscoredReason(value)).toBe(false);
    }
  });

  test('keeps refusal copy exhaustive over the authoritative vocabulary', () => {
    expect(Object.keys(TRADE_REFUSAL_COPY).sort()).toEqual([...TRADE_REFUSAL_CODES].sort());
  });

  test('publishes the complete protocol and decision knowledge', () => {
    const manual = buildProtocolManual('https://api.example.test');
    expect(manual).toContain('## 17. The Trading Floor');
    expect(manual).toContain('ClawVille trading wallet');
    expect(manual).toContain('/api/exchange/trades/report');
    expect(manual).toContain('$0.50');
    expect(manual).toContain('20');
    expect(manual).toContain('never\nreceive back-credit');
    expect(manual).toContain('[ACTION: trade_token(');
    expect(CLAWVILLE_ORIENTATION_KNOWLEDGE.some((line) => line.includes('Trading Floor'))).toBe(true);
    expect(DECISION_SCOPE.some((line) => line.toLowerCase().includes('trade'))).toBe(true);
  });

  test('publishes the ClawPump template surface on every agent-facing knowledge path', () => {
    const manual = buildProtocolManual('https://api.example.test');
    expect(manual).toContain('## 17a.');
    expect(manual).toContain('/api/floor/templates');
    // The honest limit: an unbound ClawPump wallet cannot be scored by pasting
    // a signature, because `reportTradeSignature` refuses it 409.
    expect(manual).toContain('wallet_not_bound');
    expect(CLAWVILLE_GAME_TOOLS.map((tool) => tool.name)).toContain('clawville_trading_templates');
    expect(
      CLAWVILLE_GAME_TOOLS.find((tool) => tool.name === 'clawville_trading_templates')?.description,
    ).toContain('GET {apiBase}/api/floor/templates');
    expect(
      CLAWVILLE_ORIENTATION_KNOWLEDGE.some((line) => line.includes('/api/floor/templates')),
    ).toBe(true);
  });

  test('documents the house-trader response the server actually emits', () => {
    // The previous manual assertions only checked for `## 17a.` and the two
    // paths, so nothing compared the DOCUMENTED field names against the
    // EMITTED ones. A shape change could rename a field and ship a manual that
    // describes a response the server does not send, which is the CONSUMPTION
    // MANDATE defect in its purest form. These names are the live DTO.
    const manual = buildProtocolManual('https://api.example.test');
    const section = manual.slice(manual.indexOf('### 17b.'));
    for (const field of ['objective', 'slotName', 'strategyNote', 'subject', 'counts', 'recentTrades']) {
      expect(section).toContain(field);
    }
    for (const status of ['live-observed', 'stopped', 'not-yet-running']) {
      expect(section).toContain(status);
    }
    // The renamed and removed fields must not come back in the prose.
    expect(section).not.toContain('`brief`');
    expect(section).not.toContain('`trader`');
    // Two house traders, never five.
    expect(section).toContain('TWO house traders');
    expect(section).not.toMatch(/holds five entries|same five profiles/);
    for (const surface of [CLAWVILLE_ORIENTATION_KNOWLEDGE.join('\n'), section]) {
      expect(surface).toContain('Genesis');
      expect(surface).toContain('Dip Hunter');
    }
    // The three dropped profiles must not be described as house traders.
    const houseSentence = CLAWVILLE_ORIENTATION_KNOWLEDGE.find((line) =>
      line.includes('/api/floor/house-traders'),
    );
    expect(houseSentence).toBeDefined();
    for (const dropped of ['AnsemDCA', 'MeanRevert', 'SignalFollower', 'SafeRebalancer']) {
      expect(houseSentence).not.toContain(dropped);
      expect(section).not.toContain(dropped);
    }
  });

  test('keeps both read surfaces OUT of the per-decision scope', () => {
    // DECISION_SCOPE is spread verbatim into EVERY perceive -> decide cycle
    // (agent-autonomy-driver.ts). Neither surface added an `[ACTION:]` verb, so
    // the executor menu is unchanged and the deciding model cannot act on
    // either; carrying them here would pay tokens on every tick for nothing.
    // The CONSUMPTION MANDATE is satisfied by the manual, the orientation
    // knowledge and Nori, which is where an agent that CAN act on them reads.
    for (const path of ['/api/floor/templates', '/api/floor/house-traders']) {
      expect(DECISION_SCOPE.some((line) => line.includes(path))).toBe(false);
      expect(CLAWVILLE_ORIENTATION_KNOWLEDGE.some((line) => line.includes(path))).toBe(true);
      expect(buildProtocolManual('https://api.example.test')).toContain(path);
    }
  });

  test('keeps the whole served protocol manual free of the banned outward words', () => {
    // skill-protocol-onboarding.test.ts:211,237 applies this gate to
    // buildPlayManual only, so buildProtocolManual had NO copy gate at all and
    // sections 17a/17b would have shipped ungated.
    //
    // The CT token is case-SENSITIVE here, unlike the buildPlayManual version.
    // The protocol manual legitimately documents a response field literally
    // named `ct` (`stats: { ct, level, xp, ... }`), which is a wire name, not
    // outward copy; a case-insensitive token would fail on it and force the
    // gate to be narrowed. Measured on the built manual: zero `\bCT\b`
    // case-sensitive, zero ClawTokens, zero casino, zero pet.
    const manual = buildProtocolManual('https://api.example.test');
    expect(manual).not.toMatch(/\bCT\b/);
    expect(manual).not.toMatch(/\b(?:ClawTokens?|casino|pet)\b/i);
    // Em dashes are NOT gated: the manual carries about 120 in prose that
    // predates this change. Removing them is a separate, deliberate copy pass.
    // The two sections this diff adds carry none, which is asserted here.
    for (const heading of ['### 17a.', '### 17b.']) {
      const section = manual.slice(manual.indexOf(heading));
      expect(manual.includes(heading)).toBe(true);
      expect(section.slice(0, section.indexOf('\n## ') + 1 || undefined)).not.toContain('—');
    }
  });

  test('keeps tools.json discovery aligned with the documented REST paths', () => {
    const byName = new Map(CLAWVILLE_GAME_TOOLS.map((tool) => [tool.name, tool]));
    const trade = byName.get('clawville_trade_token');
    expect(trade?.description).toContain('POST {apiBase}/api/floor/trade');
    expect(trade?.input_schema.required).toEqual(['inputMint', 'outputMint', 'amountUsd', 'reason']);
    const bind = byName.get('clawville_bind_trading_wallet');
    expect(bind?.input_schema).toMatchObject({
      properties: { action: { enum: ['challenge', 'submit', 'custodial'] } },
      required: ['action'],
    });
    expect(bind?.description).toContain('POST /api/exchange/wallets/bind/challenge');
    expect(byName.get('clawville_report_trade')?.description).toContain('POST /api/exchange/trades/report');
    expect(byName.get('clawville_my_trades')?.description).toContain('GET /api/exchange/trades/mine');
  });
});
