import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CLAWVILLE_GAME_TOOLS,
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  DECISION_SCOPE,
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_FIRST_SIGHT_SOURCES,
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_HOUSE_AGENTS,
  FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_POSITION_USD,
  FLOOR_ARENA_TEMPLATE_VERSION,
  FLOOR_ARENA_TEMPLATES,
  FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES,
} from '@clawville/shared';
import {
  ARENA_AUTO_CHANGE_MIN_GAP_MS,
  ARENA_QUIET_REPORT_INTERVAL_MS,
  ARENA_REPORT_INTERVAL_MS,
  EVIDENCE_MIN_EDGE,
  EVIDENCE_MIN_PER_SIDE,
  MIN_CLOSED_FOR_AUTO_APPLY,
} from '../floor-arena/analysis-rules';
import { townGuide } from '@clawville/agent-templates';
import { CHAIN_VERDICT_TTL_MS } from '../floor-arena/chain-checks';
import { ARENA_CONTEST_FINAL_GRACE_MS } from '../floor-arena/contest';
import { resolveLeaderboardBounds } from '../floor-arena/leaderboard';
import { PROTOCOL_VERSION, buildProtocolManual, contentHashOf, protocolPointer } from '../skill-protocol';

// Trading Arena (paper contest) knowledge surfaces, docs/trading-floor-arena.md
// D12: manual section 17c, the clawville_arena_* tools, shared orientation and
// Nori. Every fact below is compared against the FLOOR_ARENA_* constants, so a
// template, rule or contest change that skips the served copy fails here.

const API = 'https://api.example.test';
const ARENA = `${API}/api/floor/arena`;

/** The manual's duration wording: whole hours as hours, else minutes. */
function durationLabel(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min % 60 === 0 ? `${min / 60} hour${min === 60 ? '' : 's'}` : `${min} minute${min === 1 ? '' : 's'}`;
}

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

  test('rides the current protocol and the served pointer hashes the same bytes', () => {
    expect(PROTOCOL_VERSION).toBe(77);
    expect(protocolPointer(API)).toMatchObject({ version: 77, contentHash: contentHashOf(buildProtocolManual(API)) });
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
    expect(section).toMatch(/exit reason `unresolved` and no P&L\. On the `24h` and\s+`all` windows/);
    // Privacy split (arena-api Codex r2): a player's agent is public for
    // strategy, state and results only; reports and add-ons stay on /me.
    expect(section).toMatch(/carries no add-on settings, payment address,\s+provisioning state or reports/);
    expect(section).toMatch(/positions \(without entry\s+features\)/);
    expect(section).toMatch(/carries only\s+`entry`, `exit`, `param_change` and `status` events/);
    expect(section).toMatch(/`chainVerdict` of `\{ pass, fails, checkedAt \}`\s+only/);
    expect(section).toMatch(/answers 404 `no_agent` before you launch one/);
    expect(section).toMatch(/Your reports are private/);
    // Rule 6 (lead decision B): a window-opened position that has closed, at any close time.
    expect(section).toMatch(/`eligible` only when it was created by the contest end and\s+has at least one position opened inside the window and closed, before or after\s+the end;/);
    expect(section).not.toMatch(/opened and closed inside the window/);
    // Every arena tool is named in the manual, so a tool never exists without its prose.
    for (const name of Object.keys(ARENA_TOOLS)) expect(section).toContain(`\`${name}\``);
  });

  test('states D25-D27 and the template version from their constants', () => {
    const section = arenaSection();
    // D26: the $5,000 liquidity floor is not a hard rule any more.
    expect(FLOOR_ARENA_HARD_RULES.some((rule) => /liquidity/i.test(rule.label))).toBe(false);
    expect(section).not.toContain('Liquidity of $5,000 or more');
    expect(section).toMatch(/Liquidity is not a hard rule: `filters\.liq_min` is an ordinary setting/);
    for (const t of FLOOR_ARENA_TEMPLATES.filter((x) => x.params.filters.liq_min === null)) expect(section).toContain(`off in ${t.displayName}`);
    // D25: tradeable sources, GeckoTerminal-only coins shown but not traded, add-ons exempt.
    for (const prefix of FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES) expect(section).toContain(`\`${prefix}\``);
    expect(section).toMatch(/a coin seen only by GeckoTerminal is shown in the feed\s+but never traded/);
    expect(section).toMatch(/paid add-ons find are exempt/);
    for (const value of FLOOR_ARENA_FIRST_SIGHT_SOURCES) expect(section).toContain(`\`${value}\``);
    expect(section).toContain(`version ${FLOOR_ARENA_TEMPLATE_VERSION}`);
    // D27: the served numbers are the enforced ones.
    expect(section).toContain(`at least ${MIN_CLOSED_FOR_AUTO_APPLY} closed trades`);
    expect(section).toMatch(new RegExp(`at least ${EVIDENCE_MIN_PER_SIDE}, and the kept trades' mean multiple must beat the excluded\\s+trades' by at least ${EVIDENCE_MIN_EDGE}`));
    expect(section).toContain('`insufficient_evidence`');
    // New engine codes an agent sees on its own stream; the retired floor code is gone.
    expect(section).toContain('`source_not_tradeable`');
    expect(section).toContain('`exit_quote_refused`');
    expect(section).not.toContain('liq_floor');
    const orientation = CLAWVILLE_ORIENTATION_KNOWLEDGE.find((entry) => entry.startsWith('The Trading Arena is a PAPER trading contest'))!;
    expect(orientation).toContain('trades only after DexScreener or ClawPump has seen it');
    expect(orientation).toContain('liquidity is a template setting, not a hard rule');
    const nori = townGuide.knowledge.find((entry) => entry.startsWith('Nori says: the Trading Floor now runs the Trading Arena'))!;
    expect(nori).toContain('once DexScreener or ClawPump has spotted it');
  });

  test('states D28 (fresh chain check at entry) and D29 (reports kept as lessons), punch-list P4', () => {
    const section = arenaSection();
    // D28: the served age is the engine's own verdict TTL, rendered (E6.2).
    const ttl = durationLabel(CHAIN_VERDICT_TTL_MS);
    // The engine RE-READS the stored verdict at insertion (insertTimeGate); it
    // runs no new on-chain check, so the manual must not say it does.
    expect(section).toMatch(new RegExp(`CURRENT pool\\s+that is younger than ${ttl}, and the engine re-reads that check right before\\s+the buy \\(it must still pass, match the pool and be under ${ttl}\\)`));
    expect(section).not.toMatch(/checks it again right before/);
    expect(section).toContain('`chain_pending`');
    expect(section).toMatch(new RegExp(`\`chain_verdict_stale\` \\(the check is ${ttl} old or older\\)`));
    // D29: the memory sentence is the complete one, and the old partial one is gone.
    // Only FULL reports are stored: the quiet no-trade path returns before writeMemory (analysis.ts).
    expect(section).toMatch(/Every full \d+-(minute|hour) report \(not the\s+short no-trade reports\) is also stored as your avatar's own Trading Floor lesson \(in your hosted agent's memory when it is\s+awake, else in your avatar's lesson store\)\./);
    expect(section).not.toMatch(/Every report is also stored/);
    expect(section).not.toMatch(/that runtime is running, the report is also written/);
    // T1-A: only the owner's avatar chat recalls for everyone; the teacher and the
    // decide loop are hosted-only (world-teacher-chat `if (platformAgentId)`, the
    // autonomy driver); a connected agent reads the skill-memory route.
    expect(section).toMatch(/Your owner's avatar chat can recall\s+them, and for a hosted agent so can the Trading Floor teacher and its autonomous\s+decisions; a connected agent reads them with\s+GET https:\/\/api\.example\.test\/api\/agent\/:sessionId\/skills\/cron-automation\/skill-memory\./);
    expect(section).not.toMatch(/your avatar chat, the Trading Floor\s+teacher and your hosted agent's decisions/);
    const orientation = CLAWVILLE_ORIENTATION_KNOWLEDGE.find((entry) => entry.startsWith('The Trading Arena is a PAPER trading contest'))!;
    expect(orientation).toContain('keeps each of its full reports (not the short no-trade reports) as its own Trading Floor lesson');
    expect(orientation).toContain("the owner's avatar chat can recall them, and for a hosted agent so can the Trading Floor teacher and its autonomous decisions");
    expect(orientation).toContain('a connected agent reads them with GET /api/agent/:sessionId/skills/cron-automation/skill-memory');
    expect(orientation).not.toContain('which the avatar chat, the Trading Floor teacher');
    // Recall is semantic search and the write can land nowhere: never promise it.
    for (const text of [section, orientation]) expect(text).not.toMatch(/decisions recall/);
    const nori = townGuide.knowledge.find((entry) => entry.startsWith('Nori says: the Trading Floor now runs the Trading Arena'))!;
    expect(nori).toContain('keeps every full report (not the short no-trade reports) as a Trading Floor lesson');
    expect(nori).toContain('a connected agent can read those lessons from its skill-memory route');
  });

  test('says paid add-ons spend real USDC; never "no money moves" (audit-money B1)', () => {
    const orientation = CLAWVILLE_ORIENTATION_KNOWLEDGE.find((entry) => entry.startsWith('The Trading Arena is a PAPER trading contest'))!;
    const nori = townGuide.knowledge.find((entry) => entry.startsWith('Nori says: the Trading Floor now runs the Trading Arena'))!;
    expect(orientation).toContain("Paper only: no vCLAW is spent and no real tokens are bought; optional paid add-ons spend only USDC that the player sends to the agent's own wallet;");
    expect(nori).toContain("Paper trades buy nothing real and spend no vCLAW; only optional paid data add-ons spend real USDC that you send to your trader's own wallet.");
    for (const text of [orientation, nori, arenaSection()]) {
      expect(text.toLowerCase()).not.toContain('no money moves');
      expect(text).not.toContain('Nothing real is bought');
    }
    // audit-parity: the string joins around the contest name keep their space
    // (an Edit once dropped it: "route.Trading Arena Week 1 pays").
    expect(nori).toContain(`from its skill-memory route. ${FLOOR_ARENA_CONTEST.name} pays`);
    expect(orientation).toContain(`agent's own wallet; ${FLOOR_ARENA_CONTEST.name} pays`);
    for (const text of [orientation, nori]) expect(text).not.toMatch(/[.;,][A-Z]/);
  });

  test('states the add-on money lines, the private reason, the exits rule and every refusal code (audit punch lists)', () => {
    const section = arenaSection();
    const tool = (name: string) => CLAWVILLE_GAME_TOOLS.find((t) => t.name === name)!;
    // audit-money M1/M2 (addons.ts seated gate + operator pause).
    expect(section).toMatch(/Standing up or pausing stops new\s+entries and paid add-on calls \(add-ons run only while your agent is active and\s+seated\)/);
    expect(section).toMatch(/An operator pause of the arena\s+engine stops new entries and paid add-on calls for every agent\./);
    expect(tool('clawville_arena_seat').description).toContain('Standing up stops new entries and paid add-on calls');
    expect(tool('clawville_arena_set_status').description).toContain('makes no paid add-on calls');
    // audit-money M3: the same no-withdraw line as the UI (ARENA_WALLET_NO_WITHDRAW), cap rendered.
    expect(section).toMatch(new RegExp(`Send only USDC on Solana\\. You cannot withdraw\\s+USDC from this wallet in ClawVille, so send only what your add-ons will spend \\(at\\s+most \\$${FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD} a day\\)\\. ClawVille does not refund add-on spend\\.`));
    expect(tool('clawville_arena_addons').description).toContain('Send only USDC on Solana: you cannot withdraw it through ClawVille');
    // audit-parity M1: a user agent's reason is dropped from every public view (queries.ts redactArenaParamChangeForPublic).
    expect(section).toMatch(/every change is logged publicly \(the diff and its source\); your\s+`reason`, at most 280 characters, stays private and shows only in\s+`GET \/me\/events`/);
    expect(section).not.toMatch(/logged publicly with its reason/);
    // A house agent's param change keeps its reason in public (routes/floor-arena.ts: house ? paramChanges : redacted).
    expect(section).toMatch(/`GET \/me\/events` \(only a house agent's reason is public\)/);
    const update = tool('clawville_arena_update_params');
    expect(update.description).toContain('your reason stays private and shows only in GET {apiBase}/api/floor/arena/me/events');
    expect(update.description).not.toContain('logged publicly with its reason');
    expect(JSON.stringify(update.input_schema)).not.toContain('shown on the public param log');
    // audit-contest M-1: exits are frozen at entry (engine.ts exitsOf).
    expect(section).toMatch(/A change\s+applies to positions opened after it; an open\s+position keeps the exits it\s+was opened with/);
    expect(update.description).toContain('A change applies to positions opened after it; an open position keeps the exits it was opened with.');
    // audit-parity L1-L3: the codes and body shapes the live routes return.
    expect(section).toContain('an unknown report id answers 404 `report_not_found`');
    expect(tool('clawville_arena_suggestion').description).toContain('404 report_not_found');
    expect(section).toMatch(/A malformed body or an out-of-range field\s+answers 400 `invalid_body`/);
    expect(section).toMatch(/403 with an `error` that\s+starts with `agent_session_not_ledger_authorized` \(in that body `code` is the number\s+403\)/);
    expect(section).toMatch(/with `Agent session is not bound to an active avatar`/);
    expect(tool('clawville_arena_my_trader').description).toContain('403 with an error that starts with agent_session_not_ledger_authorized');
  });

  test('states D30/D31 contest scoring, the standings and reserved names, and matches the leaderboard code', () => {
    const section = arenaSection();
    // D30: the contest window counts window-OPENED positions whatever their close time.
    expect(section).toMatch(/The `contest` window counts the positions\s+OPENED inside the contest window, whatever their close time: a window position\s+that closes after the end still counts\./);
    // D31: unresolved counts nowhere on 24h/all and in reports; on contest it is a loss of its stake.
    expect(section).toMatch(/On the `24h` and\s+`all` windows, and in the \d+-(minute|hour) reports, it is left out of `realisedUsd` and\s+of every count/);
    expect(section).toMatch(new RegExp(`On the \`contest\` window it counts\\s+as a loss of its open stake: its P&L is the proceeds of its earlier sold legs\\s+minus its \\$${FLOOR_ARENA_POSITION_USD} size`));
    expect(section).toMatch(/size, that P&L is in `realisedUsd`, and it counts like any other close \(a trade, a win or a\s+loss by the sign of that P&L, and a death when proceeds divided by size is 0\.5\s+or lower\)/);
    expect(section).not.toMatch(/no P&L: it is left out of/);
    // The manual's words are the code's rules (leaderboard.ts resolveLeaderboardBounds).
    const contestBounds = resolveLeaderboardBounds('contest', new Date('2026-10-02T00:00:00Z')) as unknown as Record<string, unknown>;
    expect(contestBounds.closedTo).toBeNull();
    expect(contestBounds.unresolvedAsLoss).toBe(true);
    // "closed, before or after the end": no qualifying close cut-off may remain on the contest window.
    expect(contestBounds.qualifyingClosedTo ?? null).toBeNull();
    for (const window of ['24h', 'all'] as const) {
      expect((resolveLeaderboardBounds(window, new Date('2026-10-02T00:00:00Z')) as unknown as Record<string, unknown>).unresolvedAsLoss).toBe(false);
    }
    // GET /contest standings; the settle margin is rendered from contest.ts.
    expect(section).toMatch(new RegExp(`\`standings\` is \`provisional\` while a\\s+position opened inside the window is still open, and for ${durationLabel(ARENA_CONTEST_FINAL_GRACE_MS)} after the end\\s+in any case; then it is \`final\`\\.`));
    expect(section).toContain('`openWindowPositions` counts the positions opened');
    // Reserved names: every house agent's name, from the constant.
    expect(section).toContain('400 `name_reserved` when the');
    for (const house of FLOOR_ARENA_HOUSE_AGENTS) expect(section).toContain(house.name);
    const board = CLAWVILLE_GAME_TOOLS.find((t) => t.name === 'clawville_arena_leaderboard')!.description;
    expect(board).toContain('has at least one position opened inside the window and closed, before or after the end');
    expect(board).toContain('counts as a loss of its open stake');
    expect(board).not.toContain('opened and closed inside the window');
  });

  test('renders every 17c duration from its constant, never a typed number (E6.2)', () => {
    const section = arenaSection();
    const every = durationLabel(ARENA_REPORT_INTERVAL_MS);
    expect(section).toContain(`is re-tuned in small steps about every ${every}`);
    expect(section).toContain(`Reports. About every ${every} each agent with activity`);
    expect(section).toContain(`at most once per ${durationLabel(ARENA_AUTO_CHANGE_MIN_GAP_MS)},`);
    expect(section).toContain(`a short report at most every ${durationLabel(ARENA_QUIET_REPORT_INTERVAL_MS)}.`);
    const kind = every.replace(/ (minute|hour)s?$/, '-$1');
    expect(section).toMatch(new RegExp(`and in the ${kind} reports, it is left out`));
    expect(section).toMatch(new RegExp(`read your own\\s+${kind} report;`));
    // The builder source must not type these numbers back in.
    const src = readFileSync(join(import.meta.dir, '..', 'skill-protocol.ts'), 'utf8');
    const start = src.indexOf('function buildTradingArenaSection(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(0);
    for (const literal of [/younger than \d/, /under \d+ minutes/, /is \d+ minutes old/, /every \d+ (minutes|hours)/, /once per \d+/, /\n\d+-minute report/]) {
      expect(body).not.toMatch(literal);
    }
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
    expect(byName.get('clawville_arena_templates')!.description).toContain('a GeckoTerminal-only coin is shown but never traded');
    // The shared tool text cannot import the API's tuner constants, so pin it to them here.
    const settings = byName.get('clawville_arena_settings')!.description;
    expect(settings).toContain(`at least ${MIN_CLOSED_FOR_AUTO_APPLY} closed trades`);
    expect(settings).toContain(`number at least ${EVIDENCE_MIN_PER_SIDE} each`);
    expect(settings).toContain(`at least ${EVIDENCE_MIN_EDGE} better`);
    expect(settings).toContain('insufficient_evidence');
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
    // Rule 6 (D30): opened inside the window and closed, at any close time.
    expect(line).toContain('have at least one position opened inside the contest window and closed (the close may come after the end)');
    expect(line).not.toContain('opened and closed inside the contest window');
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
    expect(nori).toContain('open at least one position inside the contest window that has closed, even if it closes after the end');
    expect(nori).not.toContain('open and close at least one position inside the contest window');
  });

  test('adds no arena line to the per-decision scope, because no [ACTION:] verb exists for it', () => {
    expect(DECISION_SCOPE.some((line) => line.includes('/api/floor/arena'))).toBe(false);
  });
});
