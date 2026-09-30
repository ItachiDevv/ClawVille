import { describe, expect, test } from 'bun:test';
import {
  CLAWVILLE_GAME_TOOLS,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  DECISION_SCOPE,
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_POSITION_USD,
  FLOOR_ARENA_TEMPLATES,
} from '@clawville/shared';
import { townGuide } from '@clawville/agent-templates';
import { PROTOCOL_VERSION, buildProtocolManual, contentHashOf, protocolPointer } from '../skill-protocol';

// Trading Arena (paper contest) knowledge surfaces, docs/trading-floor-arena.md
// D12: manual section 17c, the clawville_arena_* tools, shared orientation and
// Nori. Every fact below is compared against the FLOOR_ARENA_* constants, so a
// template, rule or contest change that skips the served copy fails here.

const API = 'https://api.example.test';
const ARENA = `${API}/api/floor/arena`;

function arenaSection(): string {
  const manual = buildProtocolManual(API);
  const start = manual.indexOf('## 17c. Trading Arena (paper contest)');
  expect(start).toBeGreaterThan(manual.indexOf('### 17b.'));
  return manual.slice(start);
}

/** Tool name -> the method and path its description must name. */
const ARENA_TOOLS: Record<string, string> = {
  clawville_arena_templates: 'GET {apiBase}/api/floor/arena/templates',
  clawville_arena_leaderboard: 'GET {apiBase}/api/floor/arena/leaderboard?window=contest|24h|all',
  clawville_arena_agent: 'GET {apiBase}/api/floor/arena/agents/:id',
  clawville_arena_my_trader: 'GET {apiBase}/api/floor/arena/me',
  clawville_arena_launch: 'POST {apiBase}/api/floor/arena/me/launch',
  clawville_arena_update_params: 'PATCH {apiBase}/api/floor/arena/me/params',
  clawville_arena_seat: 'POST {apiBase}/api/floor/arena/me/seat',
  clawville_arena_set_status: 'POST {apiBase}/api/floor/arena/me/status',
  clawville_arena_suggestion: 'POST {apiBase}/api/floor/arena/me/suggestions/:reportId',
  clawville_arena_addons: 'PATCH {apiBase}/api/floor/arena/me/addons',
  clawville_arena_settings: 'PATCH {apiBase}/api/floor/arena/me/settings',
};

describe('Trading Arena manual section 17c', () => {
  test('is its own hosted-runtime chunk, and no chunk nears the embedding input limit', () => {
    // Hosted runtimes embed the manual one `## ` section per row, and an
    // embedding call over the model's input limit fails and SKIPS that whole
    // section (fail-soft, silent). 17c is a `## ` section so it neither bloats
    // section 17 nor rides on its fate. 24,000 characters keeps each chunk
    // well under the 8,191-token limit of text-embedding-3-small.
    const manual = buildProtocolManual(API);
    const chunks = manual.split(/\n(?=## )/);
    expect(chunks.some((chunk) => chunk.startsWith('## 17c. Trading Arena (paper contest)'))).toBe(true);
    for (const chunk of chunks) expect(chunk.length).toBeLessThan(24_000);
  });

  test('rides protocol 74 and the served pointer hashes the same bytes', () => {
    expect(PROTOCOL_VERSION).toBe(74);
    expect(protocolPointer(API)).toMatchObject({ version: 74, contentHash: contentHashOf(buildProtocolManual(API)) });
  });

  test('generates templates, hard rules, costs, size and contest from the constants', () => {
    const section = arenaSection();
    for (const t of FLOOR_ARENA_TEMPLATES) {
      expect(section).toContain(`**${t.displayName}** (\`${t.id}\`, house agent \`${t.houseAgentId}\`): ${t.tagline}`);
      expect(section).toContain(`Risk: ${t.risk}`);
    }
    for (const rule of FLOOR_ARENA_HARD_RULES) expect(section).toContain(`- ${rule.label}`);
    expect(section).toContain(`${FLOOR_ARENA_PAPER_COSTS.buy_haircut_pct}% haircut`);
    expect(section).toContain(`${FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct}% haircut`);
    expect(section).toContain(`$${FLOOR_ARENA_POSITION_USD} (fixed)`);
    expect(section).toContain(FLOOR_ARENA_CONTEST.name);
    expect(section).toContain(FLOOR_ARENA_CONTEST.startsAt);
    expect(section).toContain(FLOOR_ARENA_CONTEST.endsAt);
    for (const prize of FLOOR_ARENA_CONTEST.prizes) {
      expect(section).toContain(`${prize.amount.toLocaleString('en-US')} ${prize.token}`);
    }
    for (const rule of FLOOR_ARENA_CONTEST.rules) expect(section).toContain(`- ${rule}`);
  });

  test('documents every public read and every session-authed write with its errors', () => {
    const section = arenaSection();
    for (const path of [
      `GET ${ARENA}/templates`,
      `GET ${ARENA}/leaderboard?window=contest|24h|all`,
      `GET ${ARENA}/contest`,
      `GET ${ARENA}/agents/:id`,
      `GET ${ARENA}/agents/:id/events?after=`,
      `GET ${ARENA}/discovery?limit=`,
      `GET ${ARENA}/tape?limit=<1-24>`,
      `GET ${ARENA}/addons`,
      `GET ${ARENA}/me`,
      `GET ${ARENA}/me/events?after=`,
      `POST ${ARENA}/me/launch`,
      `PATCH ${ARENA}/me/params`,
      `POST ${ARENA}/me/seat`,
      `POST ${ARENA}/me/status`,
      `PATCH ${ARENA}/me/addons`,
      `POST ${ARENA}/me/suggestions/:reportId`,
      `PATCH ${ARENA}/me/settings`,
    ]) {
      expect(section).toContain(path);
    }
    for (const code of [
      'already_have_agent', 'invalid_params', 'live_not_available', 'unknown_template', 'unknown_addon',
      'duplicate_addon', 'addon_cap_exceeded', 'guest_not_allowed', 'agent_session_not_ledger_authorized',
      'no_agent', 'rate_limited', 'params_conflict', 'agent_stopped', 'suggestion_not_pending', 'suggestion_stale',
      'X-Clawville-Agent-Session',
    ]) {
      expect(section).toContain(code);
    }
    // The rules an agent must follow to trade and to pay.
    expect(section).toMatch(/opens NEW positions only while it is seated/);
    expect(section).toMatch(/Your agent's own\s+ClawPump wallet pays for every call/);
    expect(section).toMatch(/ClawVille never pays for them/);
    expect(section).toMatch(/never changes the position size/);
    expect(section).toMatch(/waits as `pending` until you apply or dismiss it/);
    // The leaderboard row fields the route emits, losses included.
    for (const field of ['rank', 'agentId', 'realisedUsd', 'trades', 'wins', 'losses', 'deaths', 'openPositions', 'lastTradeAt', 'eligible']) {
      expect(section).toContain(`\`${field}\``);
    }
    expect(section).toMatch(/a\s+break-even close is neither/);
    expect(section).toMatch(/exit reason `unresolved` and no P&L: it is left out of\s+`realisedUsd` and of every count/);
    // Privacy split (arena-api Codex r2): a player's agent is public for
    // strategy, state and results only; reports and add-ons stay on /me.
    expect(section).toMatch(/carries no add-on settings, payment address,\s+provisioning state or reports/);
    expect(section).toMatch(/positions \(without entry\s+features\)/);
    expect(section).toMatch(/carries only\s+`entry`, `exit`, `param_change` and `status` events/);
    expect(section).toMatch(/`chainVerdict` of `\{ pass, fails, checkedAt \}`\s+only/);
    expect(section).toMatch(/answers 404 `no_agent` before you launch one/);
    expect(section).toMatch(/Your reports are private/);
    expect(section).toMatch(/`eligible` only when it was created by the\s+contest end and has at least one trade opened and closed inside the window/);
    // Every arena tool is named in the manual, so a tool never exists without its prose.
    for (const name of Object.keys(ARENA_TOOLS)) expect(section).toContain(`\`${name}\``);
  });

  test('keeps paper arena agents apart from the live house traders and the 17a personas', () => {
    const section = arenaSection();
    expect(section).toMatch(/They are NOT the live house traders of\s+§17b/);
    expect(section).toMatch(/no arena result ever reaches the live\s+tape/);
    expect(section).toMatch(/NOT the ClawPump persona templates of §17a/);
    if (FLOOR_ARENA_TEMPLATES.some((t) => t.displayName === 'Dip Hunter')) {
      expect(section).toMatch(/The arena Dip Hunter is\s+a new paper template/);
    }
  });

  test('uses no em dash, no banned outward word and no boast', () => {
    const section = arenaSection();
    expect(section).not.toContain('—');
    expect(section).not.toMatch(/\bCT\b/);
    expect(section).not.toMatch(/\b(?:ClawTokens?|casino|pet)\b/i);
    const positive = section
      .split(/(?<=[.:])\s+/)
      .filter((sentence) => !/\b(?:not|never|no|cannot|don't|do not)\b/i.test(sentence))
      .join(' ');
    for (const claim of [/profitable/i, /(?:is|are|been)\s+winning/i, /outperform/i, /guaranteed/i, /beats?\s+the\s+market/i]) {
      expect(positive).not.toMatch(claim);
    }
  });
});

describe('Trading Arena tools', () => {
  test('every arena tool exists once and names its method and path', () => {
    const names = CLAWVILLE_GAME_TOOLS.map((tool) => tool.name);
    for (const [name, route] of Object.entries(ARENA_TOOLS)) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
      expect(CLAWVILLE_GAME_TOOLS.find((tool) => tool.name === name)!.description).toContain(route);
    }
  });

  test('write tools require the session header and match the documented bodies', () => {
    const byName = new Map(CLAWVILLE_GAME_TOOLS.map((tool) => [tool.name, tool]));
    for (const name of Object.keys(ARENA_TOOLS).filter((n) => !['clawville_arena_templates', 'clawville_arena_leaderboard', 'clawville_arena_agent'].includes(n))) {
      expect(byName.get(name)!.description).toContain('X-Clawville-Agent-Session');
    }
    const launch = byName.get('clawville_arena_launch')!;
    expect(launch.input_schema.required).toEqual(['templateId', 'params', 'mode']);
    expect(launch.input_schema.properties.templateId?.enum).toEqual(FLOOR_ARENA_TEMPLATES.map((t) => t.id));
    expect(launch.input_schema.properties.mode?.enum).toEqual(['paper']);
    expect(byName.get('clawville_arena_seat')!.input_schema.required).toEqual(['seated']);
    expect(byName.get('clawville_arena_set_status')!.input_schema.properties.status?.enum).toEqual(['active', 'paused']);
    expect(byName.get('clawville_arena_suggestion')!.input_schema.properties.action?.enum).toEqual(['apply', 'dismiss']);
    expect(byName.get('clawville_arena_leaderboard')!.input_schema.properties.window?.enum).toEqual(['contest', '24h', 'all']);
    // Row fields match the route: losses are closes below 0; break-even is neither.
    expect(byName.get('clawville_arena_leaderboard')!.description).toContain(
      'wins (closed with pnl_usd above 0), losses (closed with pnl_usd below 0; a break-even close is neither), deaths',
    );
    // The public fill tape rides on the leaderboard tool rather than a tool of its own.
    expect(byName.get('clawville_arena_leaderboard')!.description).toContain('GET {apiBase}/api/floor/arena/tape?limit=1-24');
    expect(byName.get('clawville_arena_suggestion')!.description).toContain('409 suggestion_stale');
    expect(byName.get('clawville_arena_suggestion')!.description).not.toContain('Read reports with clawville_arena_agent');
    expect(byName.get('clawville_arena_my_trader')!.description).toContain('GET {apiBase}/api/floor/arena/me/events');
    expect(byName.get('clawville_arena_agent')!.description).toContain('no add-on settings, payment address, provisioning state or reports');
  });
});

describe('Trading Arena orientation and Nori', () => {
  test('orientation states the place, the routes and the paper limit', () => {
    const line = CLAWVILLE_ORIENTATION_KNOWLEDGE.find((entry) => entry.startsWith('The Trading Arena is a PAPER trading contest'));
    expect(line).toBeDefined();
    expect(line).toContain('inside the Trading Floor building (`cron-automation`, south of the town centre)');
    expect(line).toContain('/api/floor/arena/leaderboard');
    expect(line).toContain('protocol manual section 17c');
    expect(line).toContain('clawville_arena_');
    expect(line).toContain('opens positions only while seated');
    expect(line).toContain(FLOOR_ARENA_CONTEST.name);
    for (const t of FLOOR_ARENA_TEMPLATES) expect(line).toContain(t.displayName);
    expect(line).toContain('not the live house traders');
    // The eligibility rule the constant states, paraphrased on both copy surfaces.
    expect(line).toContain('have at least one position opened and closed inside the contest window');
    // Nori spreads the orientation list, so she carries the same line.
    expect(townGuide.knowledge).toContain(line!);
  });

  test('Nori points at the Trading Floor and the manual, and leaves the arena to it', () => {
    const nori = townGuide.knowledge.find((entry) => entry.startsWith('Nori says: the Trading Floor now runs the Trading Arena'));
    expect(nori).toBeDefined();
    expect(nori).toContain('south side of the ring');
    expect(nori).toContain('only buys while it is seated');
    expect(nori).toContain('Pearl teaches outside and does not run the arena');
    expect(nori).toContain('protocol manual section 17c');
    expect(nori).toContain(`${FLOOR_ARENA_TEMPLATES.length} house agents`);
    expect(nori).toContain('open and close at least one position inside the contest window');
  });

  test('adds no arena line to the per-decision scope, because no [ACTION:] verb exists for it', () => {
    expect(DECISION_SCOPE.some((line) => line.includes('/api/floor/arena'))).toBe(false);
  });
});
