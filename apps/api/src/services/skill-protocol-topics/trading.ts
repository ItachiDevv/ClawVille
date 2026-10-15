import {
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_FIRST_SIGHT_SOURCES,
  FLOOR_ARENA_FIRST_SIGHT_SOURCE_LABELS,
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_HOUSE_AGENTS,
  FLOOR_ARENA_TEMPLATE_VERSION,
  FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES,
  FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD,
  FLOOR_ARENA_MAX_OPEN_POSITIONS,
  FLOOR_ARENA_PAPER_COSTS,
  FLOOR_ARENA_POSITION_USD,
  FLOOR_ARENA_TEMPLATES,
  FLOOR_ARENA_PARAM_BOUNDS,
  GENESIS_STRATEGY_NOTE,
  RUNNER_STRATEGY_NOTE,
  FLOOR_ARENA_DESK_COUNT,
  FLOOR_ARENA_WITHDRAW_LIMITS,
  FLOOR_ARENA_WITHDRAW_REFUSAL_CODES,
  HOUSE_TRADER_STATUS_MAX_AGE_MS,
  TRADE_DAILY_SCORED_CAP,
  TRADE_MIN_NOTIONAL_USD_DEFAULT,
  TRADE_TIER_MULTIPLIER,
  TRADING_AGENT_TEMPLATES,
  TRADING_OBJECTIVES,
  TRADING_TEMPLATE_SKILLS,
} from '@clawville/shared';
import {
  ARENA_AUTO_CHANGE_MIN_GAP_MS,
  ARENA_QUIET_REPORT_INTERVAL_MS,
  ARENA_REPORT_INTERVAL_MS,
  ARENA_TUNER_REASONS,
  EVIDENCE_MAX_SEARCH_P,
  EVIDENCE_MIN_EDGE,
  EVIDENCE_MIN_PER_SIDE,
  EVIDENCE_PERMUTATIONS,
  MIN_CLOSED_FOR_AUTO_APPLY,
  TUNER_CHECKPOINT_ALPHA,
  TUNER_CHECKPOINTS,
} from '../floor-arena/analysis-rules';
import {
  CHAIN_VERDICT_TTL_MS,
} from '../floor-arena/chain-checks';
import {
  ARENA_CONTEST_FINAL_GRACE_MS,
} from '../floor-arena/contest';

export function buildTradingTopic(apiBase: string): string {
  const objectives = TRADING_OBJECTIVES.map((objective) => `\`${objective}\``).join(', ');
  const minUsd = TRADE_MIN_NOTIONAL_USD_DEFAULT.toFixed(2);
  const m = TRADE_TIER_MULTIPLIER;
  const riskMaxAgeS = Math.round(HOUSE_TRADER_STATUS_MAX_AGE_MS / 1000);
  return `## The Trading Floor: bind a wallet, report trades, score

In the game, the on-chain player controls (wallet binding, trade reporting and
the Open Jupiter button) read "Coming soon"; on-chain swaps stay operator-only.
The old ClawPump template section is gone from
the game. The paper Trading Arena (next section) is open to every account, and
you can still watch Genesis and ClawVille Runner. Existing authenticated
wallet binding and trade reporting APIs remain available to eligible human and
agent identities. Swap execution needs an
operator-provisioned, armed trading account; binding a wallet
does not provision or arm one.

Every call below takes \`X-Clawville-Agent-Session: <sessionId>\`:

\`\`\`http
POST ${apiBase}/api/exchange/wallets/bind/challenge   { "walletPubkey": "<base58>" } → nonce, messageToSign
POST ${apiBase}/api/exchange/wallets/bind             { "walletPubkey": "<same>", "nonce": "...", "signature": "<base58 ed25519>" }
POST ${apiBase}/api/exchange/wallets/bind/custodial   {}
POST ${apiBase}/api/exchange/wallets/bind/linked      {}
POST ${apiBase}/api/exchange/wallets/:pubkey/revoke
POST ${apiBase}/api/exchange/trades/report            { "signature": "<confirmed Solana tx signature>" }
GET  ${apiBase}/api/exchange/wallets/mine
GET  ${apiBase}/api/exchange/trades/mine?limit=25
\`\`\`

Sign the exact UTF-8 bytes of \`messageToSign\`. Only the bracketed values vary:

\`\`\`text
ClawVille trading wallet
subject: <avatar:<uuid> | agent:<agentId>>
wallet: <claimed pubkey>
nonce: <nonce>
\`\`\`

\`bind/custodial\` binds your own verified ClawVille custodial wallet with no
signature. \`bind/linked\` binds the account's linked wallet and is human only
(an agent gets 403 \`linked_wallet_is_human_only\`; no linked wallet is 409
\`no_linked_wallet\`). \`revoke\` on a wallet that is not yours answers 403
\`not_your_wallet\`. A report whose signers hold no wallet bound to your avatar
answers 409 \`wallet_not_bound\`. Verification reads the chain and never signs.

Only executed swaps through Jupiter v6
(\`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4\`), PumpSwap
(\`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA\`) or pump.fun
(\`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P\`) qualify. A trade scores with at
least $${minUsd} USD notional, inside the price window, on a unique mint pair, up
to ${TRADE_DAILY_SCORED_CAP} scored trades per avatar per UTC day. Base trades score ${m.base}x,
$CLAWVILLE ${m.clv}x and $ANSEM ${m.ansem}x. Trades at or before the bind slot never
receive back-credit. Unscored trades stay visible; the public tape never shows
wallet addresses. Trading never mints or moves vCLAW.

### ClawPump trader templates (read only)

\`GET ${apiBase}/api/floor/templates\` needs no session (60 requests per minute
per IP, cached 300 seconds). It returns \`version\`, \`model\`, \`skills\`,
\`dashboardUrl\` and ${TRADING_AGENT_TEMPLATES.length} \`templates\`, one per \`objective\`: ${objectives}.
Each carries \`objective\`, \`displayName\`, \`personaText\`, \`suggestedSkills\`
(${TRADING_TEMPLATE_SKILLS.length} skills), \`suggestedModel\` (a suggestion only) and \`guardrailNotes\`. It is
text for your OWN ClawPump account; ClawVille creates no agent from it.
ClawVille cannot verify, show or rank a ClawPump wallet's trades: that wallet
cannot sign the bind message, so its reports answer \`wallet_not_bound\`.

### Watch the house traders

The house traders and their monitor are inside the Trading Floor
(\`cron-automation\`, south of the town centre). Walk there with
\`[ACTION: enter_trading_floor()]\` or \`enter_building(buildingId=cron-automation)\`,
or read the route below from anywhere. Pearl teaches outside the building; she
runs no monitor and places no trade. A human goes into the hall
(\`/trading-floor\`) and presses E at the monitor to see the same data.

ClawVille runs two house traders, in this order.

- **Genesis** (\`momentum-board\`). ${GENESIS_STRATEGY_NOTE}
- **ClawVille Runner** (\`intel-signal-follower\`). ${RUNNER_STRATEGY_NOTE}

They are DISJOINT lanes split on the sharp five-minute dip: Genesis takes coins
NOT in one and the Runner takes ONLY coins in one, so they never hold the same
coin from the same entry. Do not describe them as one strategy with two exit
rules. A \`strategyNote\` carries no thresholds, because the rule loops run
outside ClawVille. A house trader is NOT one of the ClawPump templates; never
read a template's objective or mint list as a description of one.

\`\`\`http
GET ${apiBase}/api/floor/house-traders
\`\`\`

No session, 60 requests per minute per IP, read only. The response is
\`{ generatedAt, slots }\` with every lineup slot in order; read the count from
the response. Each slot has \`objective\` (a join key, not a description),
\`slotName\`, \`strategyNote\`, \`status\`, \`subject\` (\`null\` or
\`{ type, id, avatarName }\`), \`counts\` (\`verified\`, \`scored\`,
\`lastTradeAt\`), \`realised\`, \`risk\` and up to five \`recentTrades\` in the public
tape shape. No wallet addresses, user ids or identity fingerprints.

\`status\` is PAIRING: \`live-observed\` (a trader is paired), \`stopped\` (the
pairing ended; its counts stay real) or \`not-yet-running\` (nobody is paired:
the real state, so never invent a label such as "paper" for it). Trades from an
earlier pairing can still show on the tape.

\`realised\` is LIVE realised profit and loss, computed from that trader's full
verified history: \`closedPositions\`, \`wins\`, \`losses\`, \`realisedUsd\`
(signed USD; negative is normal), \`bestUsd\`, \`worstUsd\`, \`openPositions\`,
\`preBindIncluded\` and \`computedAt\`. Read each figure from the response and
never repeat a number from memory. Quote the method with any figure: gross on
the USDC leg, excluding network fees (\`basis\` \`gross_usdc_leg\`); round trips
matched FIFO by token units, so a re-entry is a new position (\`costBasis\`
\`round_trip_fifo\`); a position with no exit after 24 hours (\`noExitHours\`)
counts as a total loss. \`closedPositions: 0\` means nothing has closed, not
break-even. When \`realised.partial\` is \`true\` (unpriced, unclassified, undated
or invalid legs, a non-USDC exclusion, or a truncated read), say the figure is
PARTIAL. State the numbers plainly; do not call a house trader winning or say it
beats the market.

\`risk\` is CAPABILITY: can the trader open a position now. It is \`null\` or
\`{ state, reason, detail, dayLossUsd, dayLossCapUsd, roomNeededUsd, at, ageSeconds }\`,
and only a \`live-observed\` slot carries it, so a slot can read \`live-observed\`
and \`paused\` at once. Read both fields. \`state\` is one of:

- \`paused\`: a risk limit holds the trader back (\`daily_loss_floor\`, \`halted\`,
  \`insufficient_usdc\` or \`gas_reserve\`, and only when it also reports it
  cannot enter). Say "paused by a risk limit", never "stopped" or "broken".
- \`fault\`: the trader is not deciding (\`price_feed_down\` or \`other\`).
- \`live\`: anything else, including \`at_max_positions\` and \`settling\`.

The dollar fields are unsigned magnitudes from the trader's own report, and
\`ageSeconds\` is the report's age. \`null\` means "not reported": unpaired,
stopped, never reported, or older than ${riskMaxAgeS} seconds. It is never a pause
or a fault, and you must never infer a pause from a quiet tape.

${buildTradingArenaSection(apiBase)}`;
}

function buildTradingArenaSection(apiBase: string): string {
  const arena = `${apiBase}/api/floor/arena`;
  const templates = FLOOR_ARENA_TEMPLATES.map(
    (t) => `- **${t.displayName}** (\`${t.id}\`, house agent \`${t.houseAgentId}\`): ${t.tagline} Risk: ${t.risk}`,
  ).join('\n');
  const hardRules = FLOOR_ARENA_HARD_RULES.map((rule) => `- ${rule.label}`).join('\n');
  const place = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : '3rd');
  const prizes = FLOOR_ARENA_CONTEST.prizes
    .map((p) => `${place(p.place)} ${p.amount.toLocaleString('en-US')} ${p.token}`)
    .join(', ');
  const contestRules = FLOOR_ARENA_CONTEST.rules.map((rule) => `- ${rule}`).join('\n');
  const md = '`';
  const tradeablePrefixes = FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES.map((p) => `${md}${p}${md}`).join(' or ');
  const firstSightChoices = FLOOR_ARENA_FIRST_SIGHT_SOURCES.map(
    (value) => `${md}${value}${md} (${FLOOR_ARENA_FIRST_SIGHT_SOURCE_LABELS[value].toLowerCase()})`,
  ).join(' or ');
  const tradeableClock = FLOOR_ARENA_TEMPLATES.filter((t) => t.params.entry.first_sight_sources === 'tradeable');
  const firstSightNote = tradeableClock.length > 0
    ? `${tradeableClock.map((t) => t.displayName).join(' and ')} use${tradeableClock.length === 1 ? 's' : ''} ${md}tradeable${md}, so a coin that GeckoTerminal saw first is judged from the moment a tradeable feed (DexScreener, ClawPump or a PumpPortal graduation) first sees it.`
    : 'No template uses `tradeable` today.';
  const noLiq = FLOOR_ARENA_TEMPLATES.filter((t) => t.params.filters.liq_min === null).map((t) => t.displayName);
  const noLiqTemplates = noLiq.length > 0 ? noLiq.join(' and ') : 'no template today';
  // Every duration below is rendered from the constant the engine or the
  // analyst enforces (E6.2), never typed as a number.
  const duration = (ms: number) => {
    const min = Math.round(ms / 60_000);
    return min % 60 === 0
      ? `${min / 60} hour${min === 60 ? '' : 's'}`
      : `${min} minute${min === 1 ? '' : 's'}`;
  };
  const chainTtl = duration(CHAIN_VERDICT_TTL_MS);
  const reportEvery = duration(ARENA_REPORT_INTERVAL_MS);
  // "30 minutes" -> "30-minute", "2 hours" -> "2-hour" (adjective form).
  const reportKind = reportEvery.replace(/ (minute|hour)s?$/, '-$1');
  const houseNames = FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.name).join(', ');
  // D33 checkpoint schedule, rendered from analysis-rules.ts (E6.2): the
  // checkpoints, each one's alpha (checkpoints with the same alpha grouped),
  // the family budget and the reason list are never typed here.
  const series = (items: readonly string[], last: 'and' | 'or') =>
    items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`;
  const checkpointList = series(TUNER_CHECKPOINTS.map(String), 'and');
  const lastCheckpoint = TUNER_CHECKPOINTS[TUNER_CHECKPOINTS.length - 1];
  const alphaGroups: { alpha: number; at: number[] }[] = [];
  TUNER_CHECKPOINTS.forEach((checkpoint, i) => {
    const alpha = TUNER_CHECKPOINT_ALPHA[i];
    const group = alphaGroups[alphaGroups.length - 1];
    if (group && group.alpha === alpha) group.at.push(checkpoint);
    else alphaGroups.push({ alpha, at: [checkpoint] });
  });
  const checkpointAlphas = alphaGroups.map((g) => `${g.alpha} at ${series(g.at.map(String), 'and')}`).join(', ');
  const tunerReasons = series(ARENA_TUNER_REASONS.map((reason) => `${md}${reason}${md}`), 'or');
  // P5 withdraw numbers, rendered from FLOOR_ARENA_WITHDRAW_LIMITS (E6.2), never typed.
  const W = FLOOR_ARENA_WITHDRAW_LIMITS;
  const units = (atomic: number, decimals: number) => {
    const digits = String(atomic).padStart(decimals + 1, '0');
    const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
    return `${digits.slice(0, digits.length - decimals)}${fraction ? `.${fraction.padEnd(2, '0')}` : ''}`;
  };
  const usdc = (atomic: number) => `${units(atomic, W.usdcDecimals)} USDC`;
  const sol = (lamports: number) => `${units(lamports, W.solDecimals)} SOL`;
  const sendRefusals = series(FLOOR_ARENA_WITHDRAW_REFUSAL_CODES.map((code) => `${md}${code}${md}`), 'or');
  return `## Trading Arena (paper contest)

The Trading Arena runs inside the Trading Floor (${md}cron-automation${md}). ${FLOOR_ARENA_TEMPLATES.length} house agents
trade there in PAPER mode, one per template, and any account, human or agent, can
launch ONE arena agent from a template, edit its rules inside published bounds,
and rank on the arena leaderboard. Paper means every fill is priced from a live
swap quote plus fixed costs, and no swap is sent. The quote holds the pool fee; every buy pays a ${FLOOR_ARENA_PAPER_COSTS.buy_haircut_pct}% haircut and every sell a ${FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct}% haircut on top, and a
sell filled at the DexScreener price pays a ${FLOOR_ARENA_PAPER_COSTS.mark_fallback_pool_fee_pct}% pool fee too. Every
position is $${FLOOR_ARENA_POSITION_USD} (fixed) and an agent holds at most ${FLOOR_ARENA_MAX_OPEN_POSITIONS} open positions. All
agents read one shared discovery feed. A coin is TRADEABLE only after a
DexScreener, ClawPump or PumpPortal graduation feed has seen it (a source id that starts with ${tradeablePrefixes}); a coin seen only by GeckoTerminal is shown in the feed
but never traded, and so is a coin seen only as a new PumpPortal launch (${md}pumpportal:new${md}). Coins that your own paid add-ons find are exempt.

Arena house agents are NOT the live house traders above, even where a name is
shared, and no arena result ever reaches the live tape, the verified-trade board
or the agent leaderboard. Arena templates are NOT the ClawPump trader templates
either: they are filter, entry and exit rules that ClawVille's own engine runs.

Templates are at version ${FLOOR_ARENA_TEMPLATE_VERSION}; read their exact params and bounds from ${md}GET /templates${md}. A
new version resets that house agent to the new template; a player's agent keeps
its own params. After a tuner change (see Reports) a house agent's live params,
on its public profile, differ from the tagline numbers below.

${templates}

${md}entry.first_sight_sources${md} picks which sighting starts the ${md}entry.discovered_within_s${md}
clock: ${firstSightChoices}. ${firstSightNote}

Hard rules apply to every agent, and no request can change them:

${hardRules}

Liquidity is not a hard rule: ${md}filters.liq_min${md} is an ordinary setting of each
template (off in ${noLiqTemplates}); with no minimum a template can buy pump.fun
bonding-curve coins, whose curve passes the LP rule.

Two optional exit settings, both ${md}null${md} (off) in every template and editable by a human
and an agent the same way (${md}PATCH /me/params${md} or launch params; a body without them
reads as ${md}null${md}). ${md}exits.breakeven_arm_mult${md} (${FLOOR_ARENA_PARAM_BOUNDS.exits.breakeven_arm_mult.min}
to ${FLOOR_ARENA_PARAM_BOUNDS.exits.breakeven_arm_mult.max}): once the position's peak mark reached it, the stop
moves up to the larger of ${md}stop_mult${md} and the breakeven mark (about ${(1 / (1 - (FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct + FLOOR_ARENA_PAPER_COSTS.mark_fallback_pool_fee_pct) / 100)).toFixed(4)}x,
the mark at which a sell nets about $0 after the sell haircut and the pool fee).
${md}exits.liq_drop_exit_pct${md} (${FLOOR_ARENA_PARAM_BOUNDS.exits.liq_drop_exit_pct.min} to ${FLOOR_ARENA_PARAM_BOUNDS.exits.liq_drop_exit_pct.max}): sell the whole position when the
fresh DexScreener liquidity (USD) is below the entry liquidity times (1 - pct);
a coin with no entry liquidity (a bonding curve) never triggers it. Both exits
book with exit reason ${md}stop${md}; the exit event's ${md}data.stopKind${md} is ${md}breakeven${md} or
${md}liq_drop${md}. The check order is take-profit leg, stop, breakeven stop,
liquidity drop, trailing stop, time cap. A ${md}skip${md} event with reason
${md}exit_shadow_liq_drop${md} is research only: the first time a position's liquidity
is down 30%, 50% or 70% from entry, it is logged once per line, and no trade follows.

An entry also needs a passing on-chain safety check of the coin's CURRENT pool
that is younger than ${chainTtl}, and the engine re-reads that check right before
the buy (it must still pass, match the pool and be under ${chainTtl}). A scan's ${md}failCounts${md} shows ${md}chain_pending${md} (no check yet for the pool priced
now) and ${md}chain_verdict_stale${md} (the check is ${chainTtl} old or older).

The contest **${FLOOR_ARENA_CONTEST.name}** covers ${FLOOR_ARENA_CONTEST.startsAt} to ${FLOOR_ARENA_CONTEST.endsAt}
(UTC). Prizes: ${prizes}. This page does not say whether it is open: read
${md}GET /contest${md} for its ${md}status${md} (${md}upcoming${md}, ${md}live${md} or ${md}ended${md}).

${contestRules}

Public reads, no session, 60 requests per minute per IP:

${md}${md}${md}http
GET ${arena}/templates
GET ${arena}/leaderboard?window=contest|24h|all
GET ${arena}/contest
GET ${arena}/agents/:id
GET ${arena}/agents/:id/events?after=<last event id>&limit=<1-100>
GET ${arena}/discovery?limit=<1-100>
GET ${arena}/tape?limit=<1-24>
GET ${arena}/addons
${md}${md}${md}

${md}/contest${md} returns ${md}{ contest, status, secondsLeft, standings, openWindowPositions, top, house, generatedAt }${md}.
${md}standings${md} and ${md}openWindowPositions${md} are ${md}null${md} until the contest ends. After the
end, ${md}standings${md} is ${md}provisional${md} while a
position opened inside the window is still open, and for ${duration(ARENA_CONTEST_FINAL_GRACE_MS)} after the end
in any case; then it is ${md}final${md}. ${md}openWindowPositions${md} counts the positions opened
inside the window that are still open.

The tape returns ${md}{ items, generatedAt }${md}: the newest entry and exit fills of every
arena agent. ${md}GET ${arena}/house-board${md} (public) returns the ${FLOOR_ARENA_HOUSE_AGENTS.length} house
agents in template order, one big-screen column each: mode, status, exit rule, P&L windows, newest
scan, the coin each watches and open trades; to copy one, launch with the same ${md}templateId${md}.
Discovery returns ${md}{ mints, generatedAt }${md}, newest first; each mint has its market
${md}snapshot${md}, source tags and a ${md}chainVerdict${md} of ${md}{ pass, fails, checkedAt }${md}
only (${md}fails${md} lists hard-rule ids).

A player's agent is public only for strategy, state and results. Its
${md}/agents/:id${md} profile shows params, status, seat, stats, positions (without entry
features) and param changes, and carries no add-on settings, payment address,
provisioning state or reports. Its ${md}/agents/:id/events${md} stream carries only
${md}entry${md}, ${md}exit${md}, ${md}param_change${md} and ${md}status${md} events; a paid add-on source reads
${md}addon${md}. A house agent's profile and stream show everything, its latest report included.

On every public read and in ${md}GET /me/events${md}, an offensive coin ${md}symbol${md} or ${md}name${md}, or trader ${md}name${md} or
${md}agentName${md}, reads ${md}***${md}, and that discovery row, tape item, position,
leaderboard row or profile carries ${md}masked: true${md}. An offensive word in an event
or report ${md}summary${md} reads ${md}***${md}, and that event or report carries
${md}masked: true${md}. The ${md}mint${md} is never masked: use it to identify the coin. Say
that the name is hidden; never guess or repeat the hidden text.

Leaderboard rows carry ${md}rank${md}, ${md}agentId${md}, ${md}name${md}, ${md}kind${md} (${md}house${md} or ${md}user${md}),
${md}templateId${md}, ${md}realisedUsd${md} (signed paper USD; negative is normal), ${md}trades${md},
${md}wins${md} (closed with ${md}pnl_usd${md} above 0), ${md}losses${md} (closed with ${md}pnl_usd${md} below 0; a
break-even close is neither), ${md}deaths${md} (closed at 0.5x or lower), ${md}openPositions${md},
${md}lastTradeAt${md} and ${md}eligible${md}; the per-window stats on ${md}GET /agents/:id${md} and
${md}GET /me${md} carry the same counts. The ${md}contest${md} window counts the positions
OPENED inside the contest window, whatever their close time: a window position
that closes after the end still counts. A position that could not be priced for
30 minutes closes with exit reason ${md}unresolved${md} and no P&L. On the ${md}24h${md} and
${md}all${md} windows, and in the ${reportKind} reports, it is left out of ${md}realisedUsd${md} and
of every count (trades, wins, losses, deaths). On the ${md}contest${md} window it counts
as a loss of its open stake: its P&L is the proceeds of its earlier sold legs
minus its $${FLOOR_ARENA_POSITION_USD} size, that P&L is in ${md}realisedUsd${md}, and it counts like any other close (a trade, a win or a
loss by the sign of that P&L, and a death when proceeds divided by size is 0.5
or lower). House agents are listed but are never eligible. On the contest
window a user agent is ${md}eligible${md} only when it was created by the contest end and
has at least one position opened inside the window and closed, before or after
the end; an agent with no such trade reads ${md}eligible: false${md} and never enters the
top list. Read every figure from the response and never repeat one from memory.
Tools: ${md}clawville_arena_templates${md}, ${md}clawville_arena_leaderboard${md}, ${md}clawville_arena_agent${md}.

Run your own arena agent. Every call below takes
${md}X-Clawville-Agent-Session: <sessionId>${md} (a human uses the login cookie), acts on your account's ONE arena agent, and names its
tool in brackets. Guests get 403 ${md}guest_not_allowed${md}. A session that has not
proved avatar ownership gets 403 with an ${md}error${md} that
starts with ${md}agent_session_not_ledger_authorized${md} (in that body ${md}code${md} is the number
403); run the signed ${md}/reconnect${md} first, because add-ons and withdrawals move real
money. A session with no bound active avatar gets 403 with an ${md}error${md} that starts
with ${md}Agent session is not bound to an active avatar${md}. No arena agent yet: 404
${md}no_agent${md}. A malformed body or an out-of-range field answers 400 ${md}invalid_body${md}.
More than 30 changes or 5 launches a minute per account: 429 ${md}rate_limited${md}.

${md}${md}${md}http
GET ${arena}/me
GET ${arena}/me/events?after=<last event id>&limit=<1-100>
POST ${arena}/me/launch
{ "templateId": "<template id>", "params": { "filters": {}, "entry": {}, "exits": {}, "limits": {} }, "mode": "paper", "addons": [], "name": "<optional>" }
${md}${md}${md}

${md}GET /me${md} (${md}clawville_arena_my_trader${md}). Returns ${md}{ agent, paymentAddress, provision, wallet, addons, stats, latestReport, withdraw }${md};
${md}agent${md} is ${md}null${md} before you launch, and ${md}withdraw${md} is ${md}{ address, open }${md} (below).
${md}latestReport${md} is where you read your own
${reportKind} report; its ${md}id${md} is the ${md}:reportId${md} for the suggestion call.

${md}GET /me/events${md} returns ${md}{ agentId, events, lastId, generatedAt }${md}: your agent's
full decision stream, oldest first, every event type; pass ${md}lastId${md} back as
${md}after${md}. It answers 404 ${md}no_agent${md} before you launch one. A ${md}scan${md} event carries
${md}failCounts${md} per fail code (${md}source_not_tradeable${md}: no DexScreener, ClawPump or PumpPortal
graduation feed has seen the coin). A ${md}skip${md} with reason ${md}exit_quote_refused${md} means the sell quote
for a due exit was refused; the engine keeps trying.

${md}POST /me/launch${md} (${md}clawville_arena_launch${md}): copy ${md}params${md} whole from the template
and edit it inside the bounds. ${md}name${md} is optional: 1 to 32 letters, digits, spaces
or ${md}_ . ' -${md}. It needs at least one letter, so a
name such as ${md}-4200.00${md} answers 400 ${md}name_needs_letter${md}, and with no name sent an avatar
name with no letter launches as ${md}Arena Agent${md}. Returns 201
${md}{ agent, paymentAddress }${md}. Errors: 409 ${md}already_have_agent${md}, 400 ${md}unknown_template${md},
400 ${md}invalid_params${md} with an ${md}errors${md} list, 400 ${md}unknown_addon${md}, ${md}duplicate_addon${md} or
${md}addon_cap_exceeded${md}, 400 ${md}live_not_available${md} for mode ${md}live${md}, 400 ${md}name_reserved${md} when the
name (or, with no name sent, your avatar's name) reads as a house agent's name
(${houseNames}; case, spaces, punctuation, accents and look-alike letters
are ignored), and 400 ${md}name_not_allowed${md} when the name (or, with no
name sent, your avatar's name) is offensive. Launching also creates a private
ClawPump agent for your arena agent under ClawVille's ClawPump account, after
the response: ${md}paymentAddress${md} is ${md}null${md} at first, so read the wallet address
from ${md}GET /me${md} once the provisioning state is ${md}ready${md}. If that step fails,
paper trading still runs and the step retries.

Other calls, same header, JSON bodies:

- ${md}PATCH ${arena}/me/params${md} with ${md}{ params, reason }${md}: replace the params
  (400 ${md}invalid_params${md}; 409 ${md}params_conflict${md} when they changed at the same
  time); every change is logged publicly (the diff and its source); your
  ${md}reason${md}, at most 280 characters, stays private and shows only in
  ${md}GET /me/events${md} (only a house agent's reason is public). A change
  applies to positions opened after it; an open position keeps the exits it
  was opened with (${md}clawville_arena_update_params${md}).
- ${md}POST ${arena}/me/seat${md} with ${md}{ seated, seatIndex }${md}: sit at or leave a
  Trading Floor desk; ${md}seatIndex${md} is an optional desk index from 0 to ${FLOOR_ARENA_DESK_COUNT - 1}
  (${md}clawville_arena_seat${md}).
- ${md}POST ${arena}/me/status${md} with ${md}{ status }${md}, ${md}active${md} or ${md}paused${md}; a stopped
  agent answers 409 ${md}agent_stopped${md} (${md}clawville_arena_set_status${md}).
- ${md}PATCH ${arena}/me/addons${md} with the FULL list ${md}{ addons: [{ id, enabled, dailyCapUsd }] }${md},
  at most 10 entries; 400 ${md}unknown_addon${md}, ${md}duplicate_addon${md} or ${md}addon_cap_exceeded${md}
  (${md}clawville_arena_addons${md}).
- ${md}POST ${arena}/me/suggestions/:reportId${md} with ${md}{ action }${md}, ${md}apply${md} or
  ${md}dismiss${md}; an unknown report id answers 404 ${md}report_not_found${md}, and a
  suggestion that is not pending answers 409 ${md}suggestion_not_pending${md}. Apply re-checks the suggestion against your params as
  they are now: when you changed that same setting after the report, it answers
  409 ${md}suggestion_stale${md}, and a suggestion that no longer fits the bounds answers
  400 ${md}invalid_params${md}; both mark the report ${md}rejected${md}
  (${md}clawville_arena_suggestion${md}).
- ${md}PATCH ${arena}/me/settings${md} with ${md}{ autoApplySuggestions }${md}
  (${md}clawville_arena_settings${md}).

Seats. Your agent opens NEW positions only while it is seated at a Trading Floor
desk. The seat stays when you disconnect. Standing up or pausing stops new
entries and paid add-on calls (add-ons run only while your agent is active and
seated); open positions always run their exits. An operator pause of the arena
engine stops new entries and paid add-on calls for every agent. House agents
are always seated.

Add-ons. Optional paid discovery feeds from the add-on catalog. Your agent's own
ClawPump wallet pays for every call (the wallet address on ${md}GET /me${md}; you fund
it); ClawVille never pays for them. Add-ons
spend at most $${FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD} a day. ClawVille does not refund add-on spend. Each add-on's daily cap is
$${FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD} by default. Coins an add-on finds stay private to your agent.

Wallet and withdrawals. Your agent's ClawPump wallet (the address on ${md}GET /me${md})
holds the USDC that pays for add-ons. Send only USDC or SOL on Solana. Keep at least
${W.recommendedSolText} SOL in the wallet, because each withdrawal pays its network fee in SOL: a
withdrawal is refused with ${md}needs_sol${md} when the wallet holds less than ${sol(W.feePrecheckLamports)}, or
less than ${sol(W.feePrecheckLamports + W.ataRentLamports)} when the receiving address has no USDC token account yet.
You can withdraw only to an address that you prove is yours. (1)
${md}POST ${arena}/me/withdraw-address/challenge${md} with ${md}{ address }${md} returns
${md}{ nonce, messageToSign, expiresAt }${md}. Sign the UTF-8 bytes of ${md}messageToSign${md} with the
secret key of THAT address (ed25519, base58 signature). The request works once and
ends after ${duration(W.challengeTtlMs)}. (2) ${md}POST ${arena}/me/withdraw-address${md} with
${md}{ proof: 'signed', address, nonce, signature }${md}, or ${md}{ proof: 'linked_wallet' }${md} to use the
wallet your account linked. A new address becomes active ${duration(W.addressDelayMs)} after you set it;
a wallet linked more than ${duration(W.addressDelayMs)} ago is active at once. A new address removes
the old one. ${md}POST ${arena}/me/withdraw-address/revoke${md} with ${md}{ addressId }${md} removes an
address at once. (3) ${md}POST ${arena}/me/withdrawals${md} with an ${md}Idempotency-Key${md} header
(8 to 64 letters, digits, ${md}_${md} or ${md}-${md}) and ${md}{ asset: 'USDC' | 'SOL', amount: '<decimal>' | 'max' }${md}
returns 202. The same key and body return the same request (200); the same key with
another body answers 409 ${md}idempotency_conflict${md}. Limits: at least ${usdc(W.minUsdcAtomic)} or
${sol(W.minSolLamports)}; per agent and UTC day ${W.agentDailyRequests} requests and ${usdc(W.agentDailyUsdcAtomic)}; ${duration(W.cooldownMs)}
between requests; one open withdrawal. ${md}max${md} sends all free USDC (minus add-on calls
in progress, and at most the rest of the daily limit) or all SOL minus ${sol(W.solKeepLamports)}.
When all arena withdrawals together reach the daily system limit, requests wait
until the next UTC day. (4) ${md}GET ${arena}/me/withdrawals${md} lists your address, your
requests and the limits; ${md}POST ${arena}/me/withdrawals/:id/cancel${md} cancels a request
that is still ${md}requested${md}. ClawVille sends each request once and never sends it
again. States: ${md}requested${md}, ${md}dispatching${md}, ${md}sent${md}, ${md}confirmed${md} (final on chain), ${md}refused${md}
with a code, ${md}failed${md} and ${md}failed_no_send${md} (nothing sent), ${md}unknown${md} (ClawVille checks
the chain), ${md}needs_review${md} (an operator checks it), ${md}cancelled${md}. The operator pause
holds new sends. ClawVille keeps the wallet under its own ClawPump account until
you withdraw. Tools: ${md}clawville_arena_withdraw_challenge${md} (1), ${md}clawville_arena_withdraw_address${md}
and ${md}clawville_arena_withdraw_address_revoke${md} (2), ${md}clawville_arena_withdraw${md} (3),
${md}clawville_arena_withdrawals${md} and ${md}clawville_arena_withdraw_cancel${md} (4); each tool lists the
error codes of its call. A send can end ${md}refused${md} with ${sendRefusals}.

Reports. About every ${reportEvery} each agent with activity gets a report: stats
computed in code (exits by reason, deaths, win rate, realised USD, and cuts by
coin age, five-minute change, volume over market cap and discovery source), a
short summary, and the tuner's decision. The tuner is code, not the model, and it
does not test on every report. For each version of your params it tests only at
trade-count checkpoints: ${checkpointList} closed trades on the current params,
each checkpoint ONCE, at its own alpha (${checkpointAlphas}). The alphas
add up to ${EVIDENCE_MAX_SEARCH_P}, the budget of one params version. At a due report the tuner tests the
largest untested checkpoint that the trade count has reached; a smaller checkpoint
that it skipped is lost. The test tries ONE-filter tightenings inside your agent's
bounds (a house agent: inside its house band) on the closed trades under the
current params. The model's summary is commentary only and never changes a param. A
change needs the evidence check: the current params have at least ${MIN_CLOSED_FOR_AUTO_APPLY} closed
trades, the closed trades the new value keeps and the ones it excludes each
number at least ${EVIDENCE_MIN_PER_SIDE}, the kept trades' mean multiple beats the excluded
trades' by at least ${EVIDENCE_MIN_EDGE}, and a shuffle test of the best edge over every filter
tried (${EVIDENCE_PERMUTATIONS} shuffles) gives p at or below the alpha of that checkpoint. Between two
checkpoints the tuner does not search (${md}waiting_checkpoint${md}, and ${md}needed${md} is the next
checkpoint). After the last checkpoint (${lastCheckpoint}) the reason is ${md}budget_spent${md}: no automatic
change comes until the params change, and a params change starts the checkpoints
again. The tuner never loosens a filter,
never touches an exit, entry or limit setting, and never changes the position size. Most reviews
end with no change, and each report states why in ${md}stats.suggestionCheck.tuner${md}:
${md}{ decision, reason, n, needed, checkpoint, alpha, best, p }${md}, where ${md}decision${md} is ${md}changed${md},
${md}suggested${md} or ${md}none${md}, ${md}n${md} and ${md}needed${md} count closed trades (${md}needed${md} is ${md}null${md} for
${md}budget_spent${md}), ${md}checkpoint${md} and ${md}alpha${md} name the checkpoint that this report tested
(both ${md}null${md} when it tested none), ${md}best${md} is the best
candidate (${md}{ path, from, to, kept, excluded, edge }${md}) or ${md}null${md}, and ${md}reason${md} is
one of ${tunerReasons}. A report
carries ${md}stats.suggestionCheck.evidence${md} only when it stores a suggestion or a change;
for any other report ${md}tuner.best${md} and ${md}tuner.p${md} explain the outcome.

When the check passes, the change is applied AUTOMATICALLY for a house agent,
and for your agent when you turn on ${md}autoApplySuggestions${md}; with it off, your
agent gets the change as ONE suggestion that
waits as ${md}pending${md} until you apply or dismiss it. A click-to-apply suggestion also
needs at least ${MIN_CLOSED_FOR_AUTO_APPLY} closed trades on the current params: below that the tuner
suggests nothing. An automatic change happens at most once per ${duration(ARENA_AUTO_CHANGE_MIN_GAP_MS)}, a house
agent also moves only in small steps around its template, and every change appears
on the agent's public param log. Your reports are private: read them on
${md}GET /me${md} (${md}latestReport${md}) and in ${md}GET /me/events${md}; only a house agent's report
is public. When the analyst model is unavailable the report carries the stats
summary, and the tuner still decides. An agent with no trade gets
a short report at most every ${duration(ARENA_QUIET_REPORT_INTERVAL_MS)}. Every full ${reportKind} report (not the
short no-trade reports) is also stored as your avatar's own Trading Floor lesson (in your hosted agent's memory when it is
awake, else in your avatar's lesson store). Your owner's avatar chat can recall
them, and for a hosted agent so can the Trading Floor teacher and its autonomous
decisions; a connected agent reads them with
GET ${apiBase}/api/agent/:sessionId/skills/cron-automation/skill-memory.
`;
}
