import { describe, expect, test } from 'bun:test';
import {
  CLAWVILLE_GAME_TOOLS,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  DECISION_SCOPE,
  GENESIS_STRATEGY_NOTE,
  HOUSE_TRADER_LINEUP,
  RUNNER_STRATEGY_NOTE,
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
    expect(PROTOCOL_VERSION).toBe(71);
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
    // 2026-09-19, two lineup moves in one day: Dip Hunter was backtested,
    // rejected and removed (2 -> 1), then ClawVille Runner was added (1 -> 2).
    // Never five. Dip Hunter may never be presented as a trader an agent can
    // watch; the drop is stated once, in past tense, so an agent that read v65
    // learns why that slot vanished.
    expect(section).toContain('ClawVille runs two house traders');
    // Both one-line summaries are the SHARED constants, so the manual, Nori and
    // the orientation knowledge cannot drift from each other or from the lineup.
    expect(section).toContain(GENESIS_STRATEGY_NOTE);
    expect(section).toContain(RUNNER_STRATEGY_NOTE);
    expect(section).not.toMatch(/holds five entries|same five profiles/);
    // Every live trader is named on both surfaces, derived from the lineup so
    // the next lineup change moves this pin with it.
    for (const surface of [CLAWVILLE_ORIENTATION_KNOWLEDGE.join('\n'), section]) {
      for (const entry of HOUSE_TRADER_LINEUP) expect(surface).toContain(entry.label);
      expect(surface).toContain('tested and dropped on 2026-09-19');
      // Dip Hunter is named only as dropped, never as a live trader.
      expect(surface).not.toMatch(/Dip Hunter, which buys|and Dip Hunter\./);
    }
    // The lineup must match what the served copy claims, in order.
    expect(HOUSE_TRADER_LINEUP.map((entry) => entry.label)).toEqual(['Genesis', 'ClawVille Runner']);
    // 2026-09-20 03:45Z: the lanes are DISJOINT, split on the sharp five-minute
    // dip. Until 2026-09-19 every surface said "same entries, different exits",
    // which is now false and would describe an exit-rule A/B test on one coin
    // stream. Ban the retired paraphrase on the SERVED surfaces, and require
    // the split to be stated, so a reader cannot be left with the old model.
    // Scoped to the house-trader copy and NEGATION-AWARE, for the same reason
    // the profit gate below is: the correct new wording is itself a negation
    // ("they never buy the same coin"), so a bare substring ban would fail on
    // the very sentence that states the fix.
    const houseCopy = [
      CLAWVILLE_ORIENTATION_KNOWLEDGE.filter(
        (line) => line.includes('house trader') || line.includes('Genesis'),
      ).join('\n'),
      section,
    ];
    const positiveOnly = (text: string) =>
      text
        .split(/(?<=[.:])\s+/)
        .filter((sentence) => !/\b(?:not|never|no|cannot|don't|do not)\b/i.test(sentence))
        .join(' ');
    for (const surface of houseCopy) {
      const positive = positiveOnly(surface);
      for (const retired of [/same entries/i, /buy the same/i, /differ only/i, /exit-rule comparison/i, /comparison of exit rules/i]) {
        expect(positive).not.toMatch(retired);
      }
      // The split must be STATED, so the fix cannot be half-applied.
      expect(surface).toMatch(/five-minute dip/);
      expect(surface).toMatch(/disjoint|never buy the same coin|never chase the same coin|never hold the same coin/i);
    }
    // An unpaired slot's real status must be documented, and the manual must
    // FORBID inventing one. Asserting the prohibition rather than banning the
    // word "paper": the prohibition itself has to say the word, so a blanket
    // ban fails on the very sentence that enforces the rule.
    expect(section).toContain('not-yet-running');
    expect(section).toMatch(/never invent a label\s+such as "paper"/);
    for (const match of section.matchAll(/\bpaper\b/gi)) {
      const runUp = section.slice(Math.max(0, match.index - 30), match.index).replace(/\s+/g, ' ');
      expect(runUp).toMatch(/such as "$/);
    }
    // The four dropped profiles must not be described as house traders.
    const houseSentence = CLAWVILLE_ORIENTATION_KNOWLEDGE.find((line) =>
      line.includes('/api/floor/house-traders'),
    );
    expect(houseSentence).toBeDefined();
    for (const dropped of ['AnsemDCA', 'MeanRevert', 'SignalFollower', 'SafeRebalancer']) {
      expect(houseSentence).not.toContain(dropped);
      expect(section).not.toContain(dropped);
    }
  });

  test('every served surface TELLS agents the board shows live P&L, and how to read it', () => {
    // 2026-09-20 FOUNDER ORDER: the no-P&L rule is REVOKED. These surfaces are
    // what a hosted agent repeats to a human, so they must now teach the
    // OPPOSITE of what they said yesterday: the figures exist, they are server
    // computed, and they must be read from the route rather than remembered.
    const manual = buildProtocolManual('https://api.example.test');
    const section = manual.slice(manual.indexOf('### 17b.'));
    const houseKnowledge = CLAWVILLE_ORIENTATION_KNOWLEDGE.filter(
      (line) => line.includes('house trader') || line.includes('Genesis'),
    ).join('\n');
    for (const surface of [section, houseKnowledge]) {
      // The figure exists and is live.
      expect(surface).toMatch(/live realised profit and loss|LIVE realised profit and loss/i);
      // It is SERVER-computed from the full history, never pasted.
      // `\s+` not a literal space: the manual is hard-wrapped, so any of these
      // phrases can straddle a newline.
      expect(surface).toMatch(/full\s+verified\s+(?:trade\s+)?history/i);
      expect(surface).toMatch(/never\s+repeat\s+(?:a|one)\s+(?:number|figure)\s+from\s+memory/i);
      // The gross basis travels with the number.
      expect(surface).toMatch(/(?:excluding|excludes|before)\s+network\s+fees/i);
      // The METHOD is published, not folklore. Both corrections from
      // 2026-09-20 must reach a reader: round trips are matched per entry
      // (so a re-entry is its own position), and a position with no exit
      // after 24 hours is booked as a total loss rather than left open.
      // Without the second sentence a reader cannot tell a rug from a hold.
      expect(surface).toMatch(/no exit after 24 hours|unsold after 24 hours|24 hours counts? as a total loss|24 hours booked as a total loss/i);
      expect(surface).toMatch(/FIFO|matched to its own sells|each buy matched/i);
    }
    // The manual must name the wire fields, or an agent cannot read the block.
    for (const field of ['realisedUsd', 'closedPositions', 'bestUsd', 'worstUsd', 'openPositions', 'preBindIncluded']) {
      expect(section).toContain(field);
    }
    // And it must say a negative figure is normal, so no agent "corrects" it.
    expect(section).toMatch(/negative is normal/i);
  });

  test('no served surface BOASTS about a house trader', () => {
    // What survives the revocation: state the number, never dress it up. The
    // lineup constant and the web panel have their own gates; this one covers
    // the two SERVED knowledge surfaces.
    const manual = buildProtocolManual('https://api.example.test');
    const section = manual.slice(manual.indexOf('### 17b.'));
    // Scoped to the HOUSE-TRADER copy, not the whole corpus: the rule is about
    // Genesis, and the wider orientation legitimately says things like "winning
    // bounties" about the game's own economy.
    const houseLines = CLAWVILLE_ORIENTATION_KNOWLEDGE.filter(
      (line) => line.includes('house trader') || line.includes('Genesis'),
    );
    expect(houseLines.length).toBeGreaterThan(0);
    const surfaces = [section, houseLines.join('\n')];
    // These surfaces legitimately carry prohibitions ("never claim a trader is
    // profitable") and, since 2026-09-20, the words "profit and loss" as the
    // NAME of the figure. Drop every NEGATED sentence, then require the
    // remainder to be free of BOASTS. Scrubbing by negation rather than by an
    // allowlist of exact sentences means a reworded prohibition keeps passing
    // while a new positive claim still fails.
    const positiveSentences = (text: string) =>
      text
        .split(/(?<=[.:])\s+/)
        .filter((sentence) => !/\b(?:not|never|no|cannot|don't|do not)\b/i.test(sentence))
        .join(' ');
    for (const surface of surfaces) {
      const positive = positiveSentences(surface);
      // NOT a bare /\bwins\b/ any more: since 2026-09-20 `wins` and `losses`
      // are PUBLISHED FIELD NAMES in the realised block, so banning the token
      // would fail on the manual's own field list. The ban is on the CLAIM.
      for (const claim of [
        /profitable/i,
        /(?:is|are|been)\s+winning/i,
        /winning\s+streak/i,
        /outperform/i,
        /beats?\s+the\s+market/i,
        /guaranteed/i,
        /crushing/i,
      ]) {
        expect(positive).not.toMatch(claim);
      }
      // "profit" may now appear as the NAME of the published figure ("profit
      // and loss") or as the order type ("take profit"/"take-profit"). What it
      // may never be is a claim, which the CLAIMS list above already blocks.
      for (const match of positive.matchAll(/profit/gi)) {
        const runUp = positive.slice(Math.max(0, match.index - 6), match.index);
        const runOn = positive.slice(match.index, match.index + 16);
        expect(`${runUp}|${runOn}`).toMatch(/take[ -]\||profit and loss/i);
      }
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
