import { describe, expect, test } from 'bun:test';

import {
  GENESIS_STRATEGY_NOTE,
  HOUSE_TRADER_LINEUP,
  RUNNER_STRATEGY_NOTE,
  HOUSE_TRADER_OBJECTIVES,
  TRADING_OBJECTIVES,
} from '../index';

// 2026-09-19, two moves in one day: Dip Hunter (`sol-usdc-mean-reversion`) was
// backtested, rejected and removed, taking the lineup to one, and ClawVille
// Runner (`intel-signal-follower`) was then added, taking it back to two. The
// constant had NO test of its own before that, which is why five separate call
// sites hard-coded "two slots" and had to be found by hand. So these pins are
// the INVARIANTS - order, identity-freedom, no digits, no profit claim - and
// every count elsewhere derives from the lineup rather than repeating a number.

describe('house trader lineup', () => {
  test('publishes exactly the traders the house actually runs, in lineup order', () => {
    expect(HOUSE_TRADER_LINEUP.map((entry) => entry.label)).toEqual(['Genesis', 'ClawVille Runner']);
    expect(HOUSE_TRADER_LINEUP.map((entry) => entry.objective)).toEqual([
      'momentum-board',
      'intel-signal-follower',
    ]);
  });

  test('carries no avatar, agent or wallet identity', () => {
    // A slot fills from `clawpump_agent_links` by objective alone, so pairing
    // happens in the database with no deploy. An id hard-coded here would
    // survive an unpair and keep naming a trader that is no longer paired.
    const serialised = JSON.stringify(HOUSE_TRADER_LINEUP);
    for (const leak of [/avatarId/i, /agentId/i, /wallet/i, /clawville-agent-/i, /\bpubkey\b/i]) {
      expect(serialised).not.toMatch(leak);
    }
    // Only the three documented fields, so a new one cannot smuggle identity in.
    for (const entry of HOUSE_TRADER_LINEUP) {
      expect(Object.keys(entry).sort()).toEqual(['label', 'objective', 'strategyNote']);
    }
  });

  test('Dip Hunter is gone, and the slot cannot come back through a stray link', () => {
    // Removed, NOT left as a `not-yet-running` slot: that status means "nobody
    // is paired YET", which would advertise a trader that will never run.
    expect(HOUSE_TRADER_LINEUP.some((entry) => entry.label === 'Dip Hunter')).toBe(false);
    expect(HOUSE_TRADER_OBJECTIVES).not.toContain('sol-usdc-mean-reversion');
    // It stays a valid objective, because it is still one of the five copyable
    // TEMPLATES. Only the HOUSE lineup dropped it. `readHouseTraderSlots`
    // filters candidates to the lineup before selection, so a link left on this
    // objective is dropped instead of resurrecting a public slot.
    expect(TRADING_OBJECTIVES).toContain('sol-usdc-mean-reversion');
  });

  test('the published objectives are derived from the lineup, never hand-listed', () => {
    expect([...HOUSE_TRADER_OBJECTIVES]).toEqual(HOUSE_TRADER_LINEUP.map((entry) => entry.objective));
  });

  test('every objective is a real trading objective and appears once', () => {
    for (const objective of HOUSE_TRADER_OBJECTIVES) {
      expect(TRADING_OBJECTIVES).toContain(objective);
    }
    expect(new Set(HOUSE_TRADER_OBJECTIVES).size).toBe(HOUSE_TRADER_OBJECTIVES.length);
    expect(new Set(HOUSE_TRADER_LINEUP.map((e) => e.label)).size).toBe(HOUSE_TRADER_LINEUP.length);
  });

  test('no strategyNote carries a number, with NO exceptions', () => {
    // The rule loops live outside this repo and change without a deploy, so any
    // threshold written here would drift into a lie on a live public surface.
    // 2026-09-19: a fully numbered Genesis note was drafted and rejected for
    // exactly that reason even though the owner supplied the numbers, so this
    // assertion is deliberately absolute rather than carve-out-by-label.
    for (const entry of HOUSE_TRADER_LINEUP) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.strategyNote.length).toBeGreaterThan(0);
      expect(entry.strategyNote).not.toMatch(/\d/);
    }
  });

  test('each note is one shared constant, used by the panel and the manuals', () => {
    const genesis = HOUSE_TRADER_LINEUP.find((entry) => entry.label === 'Genesis')!;
    const runner = HOUSE_TRADER_LINEUP.find((entry) => entry.label === 'ClawVille Runner')!;
    expect(genesis.strategyNote).toBe(GENESIS_STRATEGY_NOTE);
    expect(runner.strategyNote).toBe(RUNNER_STRATEGY_NOTE);
    expect(GENESIS_STRATEGY_NOTE).toBe(
      'Momentum on small-cap memecoins that are not in a sharp five-minute dip, with on-chain safety checks before every buy and a trailing stop from the peak. Rules only, no AI decisions.',
    );
    expect(RUNNER_STRATEGY_NOTE).toBe(
      'Sharp five-minute dips on small-cap memecoins, the same safety checks, and a wider trailing stop from the peak. Rules only, no AI decisions.',
    );
    // No label prefix on either: the panel renders `label` as the card heading
    // directly above the note, so a leading "Genesis - " printed the name twice.
    for (const note of [GENESIS_STRATEGY_NOTE, RUNNER_STRATEGY_NOTE]) {
      expect(note).not.toMatch(/^Genesis\b|^ClawVille Runner\b/);
      expect(note).not.toContain('\n');
    }
  });

  test('the two lanes are stated as DISJOINT, and the retired paraphrase cannot come back', () => {
    // 2026-09-20 03:45Z, clawPump: the lanes split on one condition. Genesis
    // takes coins NOT in a sharp five-minute dip; the Runner takes ONLY coins
    // that are. They can never buy the same coin at the same moment.
    expect(GENESIS_STRATEGY_NOTE).toMatch(/not in a sharp five-minute dip/);
    expect(RUNNER_STRATEGY_NOTE).toMatch(/^Sharp five-minute dips/);
    // Until 2026-09-19 the pair WAS "same entries, different exits". That is now
    // false and would tell a reader the pair is an exit-rule A/B test on one
    // coin stream. Ban the paraphrase on the constants; the served surfaces are
    // covered by the same ban in `trading-floor-constants.test.ts`.
    const RETIRED = [
      /same entries/i,
      /same coins?\b/i,
      /buy the same/i,
      /differ only/i,
      /exit-rule comparison/i,
      /comparison of exit rules/i,
    ];
    for (const note of [GENESIS_STRATEGY_NOTE, RUNNER_STRATEGY_NOTE]) {
      for (const retired of RETIRED) expect(note).not.toMatch(retired);
    }
    // "the same safety checks" is deliberately still allowed: the CHECKS are
    // shared, the ENTRIES are not. This asserts that distinction survives, so a
    // later tightening of the ban does not delete a true statement.
    expect(RUNNER_STRATEGY_NOTE).toContain('the same safety checks');
  });

  test('no lineup copy BOASTS, even though P&L is now public', () => {
    // 2026-09-20 FOUNDER ORDER: P&L is PUBLIC and LIVE, so the old "no P&L
    // anywhere" rule is revoked. What survives is the narrower rule: a
    // strategyNote describes RULES, never results. The realised figure lives on
    // the route and is rendered by the panel; it must never be pasted here,
    // which the no-digits test above already enforces.
    const CLAIMS = [
      /profitable/i,
      /\bwins\b/i,
      /\bwinning\b/i,
      /\bgains?\b/i,
      /outperform/i,
      /beats? the market/i,
      /guaranteed/i,
      /crushing/i,
      /\bup \d+ ?%/i,
      /\breturns of\b/i,
    ];
    const surfaces = [
      ...HOUSE_TRADER_LINEUP.map((entry) => entry.strategyNote),
      ...HOUSE_TRADER_LINEUP.map((entry) => entry.label),
      GENESIS_STRATEGY_NOTE,
      RUNNER_STRATEGY_NOTE,
    ];
    for (const surface of surfaces) {
      for (const claim of CLAIMS) expect(surface).not.toMatch(claim);
    }
    // Guard the carve-out itself: "take profit" / "take-profit" is allowed ONLY
    // as the ORDER TYPE, so the word never appears except immediately after
    // "take" with a space or a hyphen. Neither live note uses it after the
    // 2026-09-20 rewrite, so today this loop finds nothing; the carve-out stays
    // so a future note can name the order type without tripping the gate.
    for (const surface of surfaces) {
      for (const match of surface.matchAll(/profit/gi)) {
        expect(surface.slice(Math.max(0, match.index - 5), match.index)).toMatch(/take[ -]$/i);
      }
    }
  });
});
