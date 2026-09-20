import { describe, expect, test } from 'bun:test';

import {
  CLAWPUMP_DASHBOARD_URL,
  TRADING_AGENT_TEMPLATES,
  TRADING_TEMPLATE_DISPLAY_NAMES,
  TRADING_TEMPLATE_MAX_EQUITY_PCT,
  TRADING_TEMPLATE_MODEL,
  TRADING_TEMPLATE_MODEL_NOTE,
  TRADING_TEMPLATE_SKILLS,
  TRADING_TEMPLATE_VERSION,
  buildTemplatePersona,
} from './trading-agent-templates';
import {
  TRADING_CODE_LIMITS,
  TRADING_DEFAULT_COOLDOWN_SECONDS,
  TRADING_OBJECTIVE_ALLOWED_OUTPUTS,
  TRADING_OBJECTIVE_BRIEFS,
  TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT,
  TRADING_OBJECTIVES,
} from './trading-fleet';
import { TRADE_MINTS } from './trading-floor';

/** Every mint the whole fleet may ever hold, so an "extra mint" assertion can
 *  catch a symbol leaking into a persona that does not allow it. */
const ALL_MINTS = Object.values(TRADE_MINTS);

describe('ClawPump trader templates', () => {
  test('ships one template per objective, in objective order', () => {
    expect(TRADING_AGENT_TEMPLATES.map((template) => template.objective)).toEqual([
      ...TRADING_OBJECTIVES,
    ]);
    expect(TRADING_AGENT_TEMPLATES).toHaveLength(5);
    expect(TRADING_AGENT_TEMPLATES.map((template) => template.displayName)).toEqual([
      'Momentum',
      'AnsemDCA',
      'MeanRevert',
      'SignalFollower',
      'SafeRebalancer',
    ]);
  });

  test('carries each objective brief verbatim', () => {
    for (const template of TRADING_AGENT_TEMPLATES) {
      expect(template.personaText).toContain(
        `Objective: ${TRADING_OBJECTIVE_BRIEFS[template.objective]}`,
      );
      expect(template.personaText).toContain(
        `You are ${TRADING_TEMPLATE_DISPLAY_NAMES[template.objective]},`,
      );
    }
  });

  test('renders the USDC floor with the spend rule the guardrail actually applies', () => {
    for (const template of TRADING_AGENT_TEMPLATES) {
      const share = TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT[template.objective];
      if (share > 0) {
        expect(template.personaText).toContain(
          `Keep at least ${share} percent of equity in USDC. Do not spend USDC when the trade would push the USDC share below that floor.`,
        );
      } else {
        // If and only if, asserted in BOTH directions.
        expect(template.personaText).not.toContain('percent of equity in USDC');
        expect(template.personaText).not.toContain('below that floor');
      }
    }
    // momentum-board is the only 0 share, so the else branch is really taken.
    expect(TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT['momentum-board']).toBe(0);
  });

  test('lists exactly the allowed outputs, as SOL and never WSOL, with no other mint', () => {
    for (const template of TRADING_AGENT_TEMPLATES) {
      const allowed = TRADING_OBJECTIVE_ALLOWED_OUTPUTS[template.objective];
      const symbols = allowed.map((mint) => {
        if (mint === TRADE_MINTS.WSOL) return 'SOL';
        if (mint === TRADE_MINTS.USDC) return 'USDC';
        if (mint === TRADE_MINTS.ANSEM) return `$ANSEM (${mint})`;
        if (mint === TRADE_MINTS.CLAWVILLE) return `$CLAWVILLE (${mint})`;
        throw new Error(`test fixture: no symbol for ${mint}`);
      });
      expect(template.personaText).toContain(`Suggested rules: trade only ${symbols.join(', ')}.`);
      // The inverse map must render WSOL as SOL; "WSOL" names a token no
      // trader types and would not match what the Trading desk block shows.
      expect(template.personaText).not.toContain('WSOL');
      if (allowed.includes(TRADE_MINTS.WSOL)) expect(template.personaText).toContain('SOL');
      for (const mint of ALL_MINTS) {
        if (allowed.includes(mint)) continue;
        expect(template.personaText).not.toContain(mint);
      }
    }
  });

  test('keeps the two deliberate code-over-prompt mint deviations', () => {
    // The live hand-written prompts name more mints than the code allows.
    // These assertions exist so nobody "fixes" the constant back to the prompt.
    const byObjective = new Map(TRADING_AGENT_TEMPLATES.map((t) => [t.objective, t]));
    expect(byObjective.get('intel-signal-follower')?.personaText).not.toContain('$CLAWVILLE');
    expect(byObjective.get('momentum-board')?.personaText).not.toContain('$ANSEM');
    expect(byObjective.get('momentum-board')?.personaText).not.toContain('$CLAWVILLE');
  });

  test('derives every number from the fleet constants', () => {
    expect(TRADING_CODE_LIMITS.maxTradeUsd).toBe(25);
    expect(TRADING_CODE_LIMITS.maxQuoteImpactPct).toBe(3);
    expect(TRADING_CODE_LIMITS.minSolReserveLamports).toBe(20_000_000);
    expect(TRADING_DEFAULT_COOLDOWN_SECONDS).toBe(300);
    for (const template of TRADING_AGENT_TEMPLATES) {
      expect(template.personaText).toContain(
        `Never more than $${TRADING_CODE_LIMITS.maxTradeUsd} per trade.`,
      );
      expect(template.personaText).toContain(
        `Never more than ${TRADING_TEMPLATE_MAX_EQUITY_PCT} percent of equity per trade.`,
      );
      expect(template.personaText).toContain(
        `Wait at least ${TRADING_DEFAULT_COOLDOWN_SECONDS / 60} minutes between trades.`,
      );
      expect(template.personaText).toContain(
        `more than ${TRADING_CODE_LIMITS.maxQuoteImpactPct} percent price impact`,
      );
      expect(template.personaText).toContain(
        `Keep at least ${TRADING_CODE_LIMITS.minSolReserveLamports / 1_000_000_000} SOL for fees.`,
      );
      expect(template.personaText).toContain('Always get a quote before a swap.');
      expect(template.personaText).toContain('the rule wins.');
    }
  });

  test('never promises verification or a leaderboard rank a ClawPump wallet cannot get', () => {
    for (const template of TRADING_AGENT_TEMPLATES) {
      // `reportTradeSignature` refuses a signature whose signers hold no
      // already-bound wallet, and no self-serve door binds a ClawPump wallet,
      // so no verified_trades row is written: no tape, no rank.
      expect(template.personaText).toContain(
        'ClawVille verifies and scores on-chain trades only from a wallet bound to a ClawVille avatar at clawville.world/leaderboard. A ClawPump wallet cannot be bound yet, so ClawVille cannot verify, show, or rank your trades.',
      );
      // The exact false claim the frozen spec asked for, and the one the LIVE
      // ClawVille AnsemDCA still carries in its ClawPump system prompt.
      expect(template.personaText).not.toContain('Every trade you make is verified');
      expect(template.personaText).not.toMatch(/scored on the public ClawVille leaderboard/i);
    }
  });

  test('puts the honesty sentence second, where truncation cannot reach it', () => {
    // The ClawPump persona field limit is UNMEASURED and the largest persona it
    // is known to have accepted from us is 244 characters. A silent truncation
    // must not be able to delete the one sentence that stops the agent
    // believing it is ranked, so it sits directly after the identity line.
    for (const template of TRADING_AGENT_TEMPLATES) {
      const lines = template.personaText.split('\n');
      expect(lines[0]).toContain(`You are ${template.displayName},`);
      expect(lines[1]).toContain('cannot verify, show, or rank your trades');
    }
  });

  test('offers the verified ClawPump skills and a model marked as a suggestion', () => {
    expect([...TRADING_TEMPLATE_SKILLS]).toEqual([
      'defi-trading',
      'portfolio',
      'market-intel',
      'wallet-ops',
    ]);
    expect(TRADING_TEMPLATE_MODEL).toBe('moonshotai/kimi-k2.5');
    expect(TRADING_TEMPLATE_MODEL_NOTE).toContain('free-tier');
    expect(TRADING_TEMPLATE_MODEL_NOTE).toContain('AI credits');
    expect(CLAWPUMP_DASHBOARD_URL).toBe('https://agents.clawpump.tech/dashboard');
    expect(TRADING_TEMPLATE_VERSION).toBe(1);
    for (const template of TRADING_AGENT_TEMPLATES) {
      expect(template.suggestedSkills).toEqual(TRADING_TEMPLATE_SKILLS);
      expect(template.suggestedModel).toBe(TRADING_TEMPLATE_MODEL);
    }
  });

  test('separates what ClawVille enforces from what it can only suggest', () => {
    for (const template of TRADING_AGENT_TEMPLATES) {
      expect(template.guardrailNotes).toHaveLength(2);
      expect(template.guardrailNotes[0]).toContain('ENFORCES these rules for the profiles it signs for');
      expect(template.guardrailNotes[0]).toContain('only an instruction to the model');
      expect(template.guardrailNotes[0]).toContain('neither refuse a trade nor halt it');
      expect(template.guardrailNotes[1]).toContain('your own ClawPump account');
    }
  });

  test('obeys the outward copy rules and the persona length cap', () => {
    for (const template of TRADING_AGENT_TEMPLATES) {
      const copy = [template.personaText, ...template.guardrailNotes].join('\n');
      expect(copy).not.toContain('—');
      expect(copy.toLowerCase()).not.toContain('casino');
      expect(copy).not.toMatch(/\bCT\b/);
      expect(copy).not.toContain('vCLAW');
      // 1200 is a safety cap, NOT a measured ClawPump limit: the real persona
      // field length is unverified. Raise it only against a measured limit.
      expect(template.personaText.length).toBeLessThan(1200);
    }
  });

  test('builds the same persona the exported template carries', () => {
    for (const template of TRADING_AGENT_TEMPLATES) {
      expect(buildTemplatePersona(template.objective)).toBe(template.personaText);
    }
  });
});
