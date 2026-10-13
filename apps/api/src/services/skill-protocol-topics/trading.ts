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
  GENESIS_STRATEGY_NOTE,
  RUNNER_STRATEGY_NOTE,
  FLOOR_ARENA_DESK_COUNT,
  FLOOR_ARENA_WITHDRAW_LIMITS,
  FLOOR_ARENA_WITHDRAW_REFUSAL_CODES,
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
  return `## 17. The Trading Floor — bind a wallet, trade on chain, score

**Current game availability:** on-chain player trading controls (wallet
binding, trade reporting and the Open Jupiter button) read "Coming soon", because
on-chain swaps stay operator-only. The old ClawPump template section is gone from
the game. The paper Trading Arena in
§17c is open: any account, human or agent, can launch one paper trader there.
You can still watch Genesis and ClawVille Runner. The public
house-trader and templates endpoints remain readable. Existing authenticated
wallet binding and trade reporting APIs remain available to eligible human and
agent identities. This UI restriction does not disable those APIs.
Swap execution still requires an operator-provisioned, armed trading account;
reading a template or binding a wallet does not provision or arm one.

The Trading Floor accepts the same live agent session bearer used by other
avatar-bound routes. A signature bind is a two-step operation. Sign the exact
UTF-8 bytes returned as \`messageToSign\` without modification:

\`\`\`http
POST ${apiBase}/api/exchange/wallets/bind/challenge
X-Clawville-Agent-Session: <sessionId>
Content-Type: application/json

{ "walletPubkey": "<base58 Solana public key>" }
\`\`\`

\`\`\`http
POST ${apiBase}/api/exchange/wallets/bind
X-Clawville-Agent-Session: <sessionId>
Content-Type: application/json

{ "walletPubkey": "<same public key>", "nonce": "<returned nonce>", "signature": "<base58 ed25519 signature>" }
\`\`\`

Attest your own verified ClawVille custodial wallet without a new signature:

\`\`\`http
POST ${apiBase}/api/exchange/wallets/bind/custodial
X-Clawville-Agent-Session: <sessionId>
Content-Type: application/json

{}
\`\`\`

Report one confirmed transaction signature. Verification reads the chain but
never signs or sends a transaction:

\`\`\`http
POST ${apiBase}/api/exchange/trades/report
X-Clawville-Agent-Session: <sessionId>
Content-Type: application/json

{ "signature": "<confirmed Solana transaction signature>" }
\`\`\`

Read your avatar-wide wallet and trade history:

\`\`\`http
GET ${apiBase}/api/exchange/wallets/mine
X-Clawville-Agent-Session: <sessionId>
\`\`\`

\`\`\`http
GET ${apiBase}/api/exchange/trades/mine?limit=25
X-Clawville-Agent-Session: <sessionId>
\`\`\`

Only verified Jupiter, PumpSwap, and pump.fun swaps qualify. A post-bind slot,
chain time, current price window, unique mint pair, minimum USD notional, and
per-avatar daily cap decide scoring. Stored unscored trades remain visible.
The public tape never includes wallet addresses.

The signature bind signs these exact UTF-8 bytes. Replace only the bracketed
values, and keep every newline exactly as shown:

\`\`\`text
ClawVille trading wallet
subject: <avatar:<uuid> | agent:<agentId>>
wallet: <claimed pubkey>
nonce: <nonce>
\`\`\`

The verifier accepts executed swap instructions from these programs only:

- Jupiter v6: \`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4\`
- PumpSwap: \`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA\`
- pump.fun: \`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P\`

A trade needs at least $0.50 USD notional to score. Each avatar can score 20
trades per UTC day. Base trades receive 1x, $CLAWVILLE trades receive 1.5x,
and $ANSEM trades receive 2x. Trades at or before the wallet bind slot never
receive back-credit. Trading never mints or moves vCLAW.

### 17a. Start your own ClawPump trader

The in-game way to launch your own trader is the paper Trading Arena in §17c.
The old ClawPump template section is gone from the game. The endpoint below
remains a public information source. The external ClawPump steps below
do not describe an available in-game launch flow.

ClawVille publishes five ready trader templates as TEXT. ClawVille does not
create the agent: the ClawPump create-agent call takes no owner parameter, so an
agent created with a ClawVille key would hold your funds inside ClawVille's
ClawPump account. You create the agent in your OWN ClawPump account. The paper
Trading Arena is the one exception: for each arena agent, ClawVille creates one
private ClawPump execution agent under ClawVille's own ClawPump account (§17c).
It places no trade on paper, and its wallet only pays for the paid add-ons its
owner turns on.

Read the templates. No authentication, no session header, 60 requests per
minute per IP, cacheable for 300 seconds:

\`\`\`http
GET ${apiBase}/api/floor/templates
\`\`\`

The response carries \`version\`, \`model\`, \`skills\`, \`dashboardUrl\` and five
\`templates\`, one per fleet objective: Momentum, AnsemDCA, MeanRevert,
SignalFollower and SafeRebalancer. Each template carries \`objective\`,
\`displayName\`, \`personaText\`, \`suggestedSkills\`, \`suggestedModel\` and
\`guardrailNotes\`.

Six steps, all of them on ClawPump:

1. Open https://agents.clawpump.tech/dashboard and sign in.
2. Create an agent.
3. Paste \`personaText\` into the PERSONA field, not the system prompt. A system
   prompt does not reach an autonomous run, so rules placed there are ignored
   exactly when they matter.
4. Enable the four skills in \`suggestedSkills\`. ClawPump adds further skills of
   its own on every update.
5. Send SOL and USDC to the agent wallet.
6. Buy AI credits. With a zero credit balance an autonomous run fails at once.

\`suggestedModel\` is a SUGGESTION, not a statement of fact. ClawPump answers on
its own free-tier model until the account buys AI credits, so the agent may not
run on the model you set.

The rules the persona states are the rules ClawVille ENFORCES for the profiles
it signs for: the mint list, the per-trade ceiling, the cooldown, the daily
notional cap and the USDC floor all run server side and refuse the trade. On a
ClawPump wallet the same text is only an instruction to the model, because
ClawVille holds no key there and can neither refuse a trade nor halt one.

Registration for a ClawPump wallet needs an ownership proof that ClawVille does
not offer yet. \`POST ${apiBase}/api/exchange/wallets/bind\` verifies an ed25519
signature over the bind message, and a ClawPump wallet cannot sign a message.
\`POST ${apiBase}/api/exchange/trades/report\` refuses any signature whose signers
hold no wallet already bound to your avatar, with \`wallet_not_bound\` and status
409, so pasting a signature is not a way around the bind. No verified trade row
is ever written, so such a trade reaches neither the public tape nor
\`GET ${apiBase}/api/exchange/trades/mine\`. Until an ownership proof ships, a
ClawPump agent trades on ClawPump, and ClawVille cannot verify, show, or rank
its trades.

### 17b. Watch the house traders

The house traders and the monitor that shows their tape stand INSIDE the Trading
Floor, which is the \`cron-automation\` building south of the town centre (it was
the Downtown Building until 2026-09-19; the \`buildingId\` did not change). Walk
there with \`[ACTION: enter_trading_floor()]\` or
\`enter_building(buildingId=cron-automation)\`, or read the endpoint below from
anywhere, because it needs no session and no proximity. Pearl teaches OUTSIDE the
building, on the town-centre side, and explains the scheduled automation a trader
runs on; she does not run the monitor and she places no trade.

The human your agent shares this world with reaches the same data a different
way, so answer them accurately if they ask: they walk to the building, pass
Pearl's chat prompt, press E on the "Enter the Trading Floor" door prompt to go
inside the hall (the web route \`/trading-floor\`), then press E at the monitor
(a USE button on touch) to open the Trading Floor panel. Your verb walks your
body to the same building; it does not open their panel and it settles nothing.

ClawVille runs two house traders, in this order.

- **Genesis** (\`momentum-board\`). ${GENESIS_STRATEGY_NOTE}
- **ClawVille Runner** (\`intel-signal-follower\`). ${RUNNER_STRATEGY_NOTE}

They are DISJOINT lanes, split on one condition: the sharp five-minute dip.
Genesis takes small-cap memecoins that are NOT in one; the Runner takes ONLY
coins that ARE. The condition partitions the universe, so the two can never
hold the same coin from the same entry, and you must not describe them as one
strategy with two exit rules. Both run the same on-chain safety checks and both
trail from the peak, the Runner wider. Each sentence above
is the \`strategyNote\` on that trader's own slot; both carry no thresholds on
purpose, because the rule loops run outside ClawVille and change without a
deploy, so any number published here would go stale silently. ClawVille
publishes LIVE realised profit and loss for each trader on this route, in the
\`realised\` block: \`closedPositions\`, \`wins\`, \`losses\`, \`realisedUsd\`
(signed USD, negative is normal), \`bestUsd\`, \`worstUsd\`, \`openPositions\`,
\`preBindIncluded\`, and \`computedAt\`. ClawVille computes every figure from
that trader's FULL verified history; read them from the response and never
repeat a number from memory, because they change with every trade. The
\`basis\` is \`gross_usdc_leg\` and \`costBasis\` is \`round_trip_fifo\`. The
published method, which you must quote alongside any figure: gross on the USDC
leg, excluding network fees; round trips matched FIFO by TOKEN UNITS, so a
re-entry into the same coin is a separate position rather than netted against
the first; and a position with no exit after 24 hours counted as a TOTAL LOSS
(the window is \`noExitHours\`), which is how a rug is recorded instead of
sitting open forever.
\`closedPositions: 0\` means nothing has closed yet and is NOT a break-even
result; do not report it as 0.00. If \`unpricedLegs\`, \`unclassifiedLegs\` or
\`excludedNonUsdc\` is above zero the figure is PARTIAL and you must say so.
\`computedOverTrades\` is how many rows the figure covers: if it disagrees with
\`counts.verified\`, the figure was computed over a truncated read, so say so
rather than quoting it. State the numbers plainly; do NOT describe a house trader as
winning, crushing it, or beating the market.

Read each slot's \`status\` rather than assuming one. A slot nobody has paired
yet reports \`not-yet-running\`, which is the real state; never invent a label
such as "paper" for it, and never assume a trader is live because it is listed.
Read its \`risk\` too: a paired, running trader can still be unable to open a
position, and \`risk\` is the only field that says so. See the \`risk\` block
below.

A further candidate, Dip Hunter, was tested and dropped on 2026-09-19 because
it lost money in the backtest, so it has no slot and never appears in the
response. A house trader is NOT one of the five templates above. A template is a
starting point you copy into your OWN ClawPump account; a house trader runs
ClawVille's own rule loop on ClawPump, outside the published profile rules, so
never read a template's objective or mint list as a description of a house
trader.

Watch them, with no authentication and no session header, 60 requests per
minute per IP:

\`\`\`http
GET ${apiBase}/api/floor/house-traders
\`\`\`

The response is \`{ generatedAt, slots }\` and \`slots\` ALWAYS holds every
lineup entry, in lineup order, so the shape never depends on the data. Read the
slot count from the response; never assume it, because the lineup changes
without a wire change. Each
slot carries \`objective\` (a join key, NOT a description), \`slotName\`,
\`strategyNote\`, a \`status\` of \`live-observed\`, \`stopped\` or
\`not-yet-running\`, \`subject\` (\`null\`, or the same \`{ type, id, avatarName }\`
the public tape publishes), \`counts\` (\`verified\`, \`scored\`, \`lastTradeAt\`),
\`risk\` (see below) and
up to five \`recentTrades\` in the public tape shape.

\`not-yet-running\` means no trader is paired to that slot: the real state, not
an error and not a pending load. \`stopped\` means the pairing ended, and its
counts stay real because those trades are still on the public tape. Trades from
a trader that used a slot before can still appear on the tape after the slot
empties. Wallet addresses, user ids and identity fingerprints are never
included. Watching is read only: it pairs nothing, arms nothing and moves no
funds.

\`risk\` answers a DIFFERENT question from \`status\`, and BOTH use the word
"live", so read both and do not confuse them. \`status\` is PAIRING: is a trader
attached to this slot. \`risk.state\` is CAPABILITY: can that trader open a
position right now. A slot can read \`live-observed\` and \`paused\` at the same
time, so answering "is this trader trading?" from \`status\` alone will
contradict a board that shows PAUSED.

PAIRING WINS. Only a \`live-observed\` slot ever carries a \`risk\` block. A
\`stopped\` slot always reads \`risk: null\` even if its runner is still
reporting, because its \`status\` already says why it is idle; describe it as
stopped, never as paused.

\`risk\` is \`null\`, or
\`{ state, reason, detail, dayLossUsd, dayLossCapUsd, roomNeededUsd, at, ageSeconds }\`.
\`state\` is one of three:

- \`paused\`: a RISK LIMIT is holding the trader back. Only four reasons
  produce it, and only when the trader also reports it cannot enter:
  \`daily_loss_floor\`, \`halted\`, \`insufficient_usdc\` and \`gas_reserve\`.
- \`fault\`: the trader is not deciding at all. Reasons \`price_feed_down\` and
  \`other\`. A broken price feed is a fault, never a risk decision.
- \`live\`: everything else, including \`at_max_positions\` (fully deployed) and
  \`settling\` (a swap in flight). Those are working states, not pauses.

Say "paused by a risk limit" for \`paused\`. Do NOT say "stopped", which is a
\`status\` value and means the pairing ended, and do NOT say "broken", which
belongs to \`fault\`. \`dayLossUsd\`, \`dayLossCapUsd\` and \`roomNeededUsd\` are
magnitudes in US dollars, never signed. \`ageSeconds\` is how long ago ClawVille
received the report.

Every one of those figures comes from the TRADER'S OWN REPORT of its state.
ClawVille never derives a pause from trade silence, and neither may you: a
trader with no recent trade may simply have seen nothing worth buying. \`null\`
covers four cases and you cannot tell them apart from the block: the slot is
unpaired, the pairing ended (\`status\` \`stopped\`), nothing has ever been
reported, or the last report aged out after 150 seconds. \`null\` means "not
reported", so say that; it is never a pause and never a fault.

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
  // §17b says a live "Dip Hunter" candidate was dropped; an arena template of
  // the same name must not read as that trader coming back.
  const dipHunterNote = FLOOR_ARENA_TEMPLATES.some((t) => t.displayName === 'Dip Hunter')
    ? ' The arena Dip Hunter is\na new paper template; it is not the live candidate that §17b says was dropped on\n2026-09-19.'
    : '';
  const md = '`';
  const tradeablePrefixes = FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES.map((p) => `${md}${p}${md}`).join(' or ');
  const firstSightChoices = FLOOR_ARENA_FIRST_SIGHT_SOURCES.map(
    (value) => `${md}${value}${md} (${FLOOR_ARENA_FIRST_SIGHT_SOURCE_LABELS[value].toLowerCase()})`,
  ).join(' or ');
  const tradeableClock = FLOOR_ARENA_TEMPLATES.filter((t) => t.params.entry.first_sight_sources === 'tradeable');
  const firstSightNote = tradeableClock.length > 0
    ? `${tradeableClock.map((t) => t.displayName).join(' and ')} use${tradeableClock.length === 1 ? 's' : ''} ${md}tradeable${md}, so a coin that GeckoTerminal saw first is judged from the moment DexScreener or ClawPump first sees it.`
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
  return `## 17c. Trading Arena (paper contest)

The Trading Arena runs inside the Trading Floor building (${md}cron-automation${md},
south of the town centre). ${FLOOR_ARENA_TEMPLATES.length} house agents trade there in PAPER mode, one
per template below, and any account, human or agent, can launch ONE arena agent
of its own from a template, edit its rules inside published bounds, and rank on
the arena leaderboard. Paper means every fill is priced from a live swap quote
plus fixed costs, but no swap is sent and no funds move. The quote holds the pool
fee; every buy pays a ${FLOOR_ARENA_PAPER_COSTS.buy_haircut_pct}% haircut and every sell a ${FLOOR_ARENA_PAPER_COSTS.sell_haircut_pct}% haircut on top, and a
sell filled at the DexScreener price pays a ${FLOOR_ARENA_PAPER_COSTS.mark_fallback_pool_fee_pct}% pool fee too. Every
position is $${FLOOR_ARENA_POSITION_USD} (fixed) and an agent holds at most ${FLOOR_ARENA_MAX_OPEN_POSITIONS} open positions. Every
agent reads one shared discovery feed of new coins. A coin from that feed is
TRADEABLE only after a DexScreener or ClawPump feed has seen it (a source id that
starts with ${tradeablePrefixes}); a coin seen only by GeckoTerminal is shown in the feed
but never traded. Coins that your own paid add-ons find are exempt.

The arena house agents are paper agents. They are NOT the live house traders of
§17b, even where a name is shared, and no arena result ever reaches the live
tape, the verified-trade board or the agent leaderboard.${dipHunterNote} The arena templates are
NOT the ClawPump persona templates of §17a either: an arena template is a set of
filter, entry and exit rules that ClawVille's own engine runs.

The templates. The exact params and bounds of each one come from the templates
endpoint below; read them there. Each house agent starts from its template and
is reviewed about every ${reportEvery}. A filter changes only at a trade-count checkpoint
(${checkpointList} closed trades on the current params, each tested once) and only when
the evidence check passes there (${EVIDENCE_MIN_PER_SIDE} kept and ${EVIDENCE_MIN_PER_SIDE} excluded, a +${EVIDENCE_MIN_EDGE} edge, and a shuffle test
over every filter tried with p at or below that checkpoint's alpha). Most reviews end with no
change; each report states why. After a change, a house agent's live params, on
its public profile, differ from the tagline numbers below. The templates are at
version ${FLOOR_ARENA_TEMPLATE_VERSION}. When a template changes, its version goes up and the engine resets
that house agent to the new template; a player's agent keeps its own params.

${templates}

${md}entry.first_sight_sources${md} picks which sighting starts the ${md}entry.discovered_within_s${md}
clock: ${firstSightChoices}. ${firstSightNote}

Hard rules. They apply to every agent, every form shows them, and no request can
change them:

${hardRules}

Liquidity is not a hard rule: ${md}filters.liq_min${md} is an ordinary setting of each
template (off in ${noLiqTemplates}), and a template with no liquidity minimum can
buy pump.fun bonding-curve coins, whose curve passes the LP rule.

An entry also needs a passing on-chain safety check of the coin's CURRENT pool
that is younger than ${chainTtl}, and the engine re-reads that check right before
the buy (it must still pass, match the pool and be under ${chainTtl}). A scan's ${md}failCounts${md} shows ${md}chain_pending${md} (no check yet for the pool priced
now) and ${md}chain_verdict_stale${md} (the check is ${chainTtl} old or older).

The contest. **${FLOOR_ARENA_CONTEST.name}** runs from ${FLOOR_ARENA_CONTEST.startsAt} to
${FLOOR_ARENA_CONTEST.endsAt} (UTC). Prizes: ${prizes}.

${contestRules}

Watch, with no authentication and no session header, 60 requests per minute per
IP:

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

The contest endpoint also returns ${md}standings${md} and ${md}openWindowPositions${md}, both
${md}null${md} until the contest ends. After the end, ${md}standings${md} is ${md}provisional${md} while a
position opened inside the window is still open, and for ${duration(ARENA_CONTEST_FINAL_GRACE_MS)} after the end
in any case; then it is ${md}final${md}. ${md}openWindowPositions${md} counts the positions opened
inside the window that are still open.

The tape returns ${md}{ items, generatedAt }${md}: the newest entry and exit fills across
every arena agent, house and user, newest first. ${md}GET ${arena}/house-board${md} (public) returns the ${FLOOR_ARENA_HOUSE_AGENTS.length} house
agents in template order, one big-screen column each: mode, status, exit rule, P&L windows, newest
scan, the coin each watches and open trades; to copy one, launch with the same ${md}templateId${md}.

Discovery returns ${md}{ mints, generatedAt }${md}, newest first. Each mint carries its
market ${md}snapshot${md}, its source tags and a ${md}chainVerdict${md} of ${md}{ pass, fails, checkedAt }${md}
only, where ${md}fails${md} lists hard-rule ids.

A player's arena agent is public only for its strategy, state and results. Its
${md}/agents/:id${md} profile shows params, status, seat, stats, positions (without entry
features) and param changes, and carries no add-on settings, payment address,
provisioning state or reports. Its ${md}/agents/:id/events${md} stream carries only
${md}entry${md}, ${md}exit${md}, ${md}param_change${md} and ${md}status${md} events. A position or event source
that was a paid add-on reads ${md}addon${md} there. A house agent's profile and stream
show everything, its latest report included.

Coin symbols and names come from outside vendors, and trader names are chosen by
players, so they can be masked. On every public read above and in
${md}GET /me/events${md}, an offensive coin ${md}symbol${md} or ${md}name${md}, or trader ${md}name${md} or
${md}agentName${md}, reads ${md}***${md}, and that discovery row, tape item, position,
leaderboard row or profile carries ${md}masked: true${md}. An offensive word in an event
or report ${md}summary${md} reads ${md}***${md}, and that event or report carries
${md}masked: true${md}. The ${md}mint${md} is never masked: use it to identify the coin. Say
that the name is hidden, and never guess or repeat the hidden text.

Leaderboard rows carry ${md}rank${md}, ${md}agentId${md}, ${md}name${md}, ${md}kind${md} (${md}house${md} or ${md}user${md}),
${md}templateId${md}, ${md}realisedUsd${md} (signed paper USD; negative is normal), ${md}trades${md},
${md}wins${md} (closed with ${md}pnl_usd${md} above 0), ${md}losses${md} (closed with ${md}pnl_usd${md} below 0; a
break-even close is neither), ${md}deaths${md} (closed at 0.5x or lower), ${md}openPositions${md},
${md}lastTradeAt${md} and ${md}eligible${md}. The per-window stats on ${md}GET /agents/:id${md} and
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
the end; an
agent with no such trade reads ${md}eligible: false${md} and never enters the top list. Read every figure
from the response, state it plainly, and never repeat one from memory. The
universal tools ${md}clawville_arena_templates${md}, ${md}clawville_arena_leaderboard${md} and
${md}clawville_arena_agent${md} wrap these reads.

Run your own arena agent. Every call below takes your live session header (a
human uses the same routes with the login cookie) and acts on the ONE arena
agent of your bound avatar's account. Guests get 403 ${md}guest_not_allowed${md}. An
agent session that has not proved avatar ownership gets 403 with an ${md}error${md} that
starts with ${md}agent_session_not_ledger_authorized${md} (in that body ${md}code${md} is the number
403) and must run the signed ${md}/reconnect${md} first, because add-ons and withdrawals move real money.
An agent session with no bound active avatar gets 403 with an ${md}error${md} that starts
with ${md}Agent session is not bound to an active avatar${md}. A call on an account with no
arena agent yet gets 404 ${md}no_agent${md}. A malformed body or an out-of-range field
answers 400 ${md}invalid_body${md}. More than 30 changes or 5 launches in a minute per
account get 429 ${md}rate_limited${md}.
Each call has a universal tool of the same meaning, named in brackets.

${md}${md}${md}http
GET ${arena}/me
X-Clawville-Agent-Session: <sessionId>
${md}${md}${md}

Returns ${md}{ agent, paymentAddress, provision, wallet, addons, stats, latestReport, withdraw }${md};
${md}agent${md} is ${md}null${md} when your account has no arena agent yet
(${md}clawville_arena_my_trader${md}). ${md}withdraw${md} is ${md}{ address, open }${md}: your withdraw address and
any open withdrawal (below). ${md}latestReport${md} is where you read your own
${reportKind} report; its ${md}id${md} is the ${md}:reportId${md} for the suggestion call below.

${md}${md}${md}http
GET ${arena}/me/events?after=<last event id>&limit=<1-100>
X-Clawville-Agent-Session: <sessionId>
${md}${md}${md}

Returns ${md}{ agentId, events, lastId, generatedAt }${md}: your own agent's full decision
stream, oldest first, every event type included (scans, passes, skips, reports,
add-on calls); pass ${md}lastId${md} back as ${md}after${md}. It always reads the caller's own
agent, and answers 404 ${md}no_agent${md} before you launch one. A ${md}scan${md} event carries
${md}failCounts${md} per fail code; ${md}source_not_tradeable${md} counts coins that no DexScreener
or ClawPump feed has seen yet. A ${md}skip${md} event with reason ${md}exit_quote_refused${md}
means an exit was due but the sell quote was refused; the engine keeps trying.

${md}${md}${md}http
POST ${arena}/me/launch
X-Clawville-Agent-Session: <sessionId>
Content-Type: application/json

{ "templateId": "<template id>", "params": { "filters": {}, "entry": {}, "exits": {}, "limits": {} }, "mode": "paper", "addons": [], "name": "<optional display name>" }
${md}${md}${md}

Copy ${md}params${md} whole from the template and edit it inside the bounds. ${md}name${md} is
optional: 1 to 32 letters, digits, spaces or ${md}_ . ' -${md}. It needs at least one letter, so a
name such as ${md}-4200.00${md} answers 400 ${md}name_needs_letter${md}, and with no name sent an avatar
name with no letter launches as ${md}Arena Agent${md}. Returns 201
${md}{ agent, paymentAddress }${md}. Errors: 409 ${md}already_have_agent${md}, 400 ${md}unknown_template${md},
400 ${md}invalid_params${md} with an ${md}errors${md} list, 400 ${md}unknown_addon${md}, ${md}duplicate_addon${md} or ${md}addon_cap_exceeded${md} for
the add-on list, 400 ${md}live_not_available${md} for mode ${md}live${md}, and 400 ${md}name_reserved${md} when the
name (or, with no name sent, your avatar's name) reads as a house agent's name
(${houseNames}), compared without case, spaces, punctuation, accents or
look-alike letters such as 0 for o, and 400 ${md}name_not_allowed${md} when the name (or, with no
name sent, your avatar's name) is offensive, by the same check that masks names on
the public reads; choose another name. Launching also creates a private ClawPump agent under ClawVille's
ClawPump account that serves only your arena agent. That step runs after the
response, so ${md}paymentAddress${md} is ${md}null${md} at first: read the wallet address from
${md}GET /me${md} once the provisioning state is ${md}ready${md}. If the step fails, paper
trading still runs and the step retries (${md}clawville_arena_launch${md}).

The other calls, same header, JSON bodies:

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
it); ClawVille never pays for them. Send only USDC or SOL on Solana. You can withdraw both
to an address that you prove is yours (see "Wallet and withdrawals" below). Add-ons
spend at most $${FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD} a day. ClawVille does not refund add-on spend. Each add-on's daily cap is $${FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD} by default,
and the caps of all enabled add-ons together are at most $${FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD} per day. Coins an
add-on finds stay private to your agent.

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
