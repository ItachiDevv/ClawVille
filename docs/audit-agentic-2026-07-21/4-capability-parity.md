# Capability Parity Audit — Agent Reachability of ClawVille Economy Surfaces

**Audited by:** Codex (read-only, sandbox=read-only, --effort high), via codex-companion.mjs, at repo checkout `C:/Users/itachi/Documents/Crypto/cv-audit`.
**HEAD audited:** `ac12da229934365ffa545aedbce5165dd824093a` (prod HEAD, detached, clean tree — confirmed exact match).
**Scope:** Founder concern #4 — can agents actually exercise ClawVille's capabilities end to end (e.g. play cards in the Cove), does an in-game skill file reach the agent decision loop, and can a user's own external agent's own skill be exercised through our surface.

No code was changed. This is an audit-only deliverable — no fixes proposed or implemented.

---

Audited read-only at exact HEAD `ac12da229934365ffa545aedbce5165dd824093a`.

## (A) Capability × reachability

### `[ACTION:]` whitelist parity

`PROTOCOL_VERSION` is exactly 31 at [skill-protocol.ts:313](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:313).

| Verb | Executor | Protocol manual | Parity |
|---|---|---|---|
| `move` | [npc-simulation.ts:1809](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1809) | [skill-protocol.ts:696](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:696) | Yes |
| `emote` | [npc-simulation.ts:1832](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1832) | [skill-protocol.ts:700](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:700) | Yes |
| `enter_building` | [npc-simulation.ts:1854](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1854) | [skill-protocol.ts:711](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:711) | Yes |
| `enter_cove` | [npc-simulation.ts:1881](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1881) | [skill-protocol.ts:724](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:724) | Yes |
| `enter_poker_room` | [npc-simulation.ts:1913](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1913) | [skill-protocol.ts:726](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:726) | Yes |
| `enter_kelp_forest` | [npc-simulation.ts:1944](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1944) | [skill-protocol.ts:728](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:728) | Yes |
| `talk_to_npc` | [npc-simulation.ts:1966](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/npc-simulation.ts:1966) | [skill-protocol.ts:719](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:719) | Yes |

The shared canonical tuple also contains exactly those seven verbs at [hatcher-actions.ts:10](/C:/Users/itachi/Documents/Crypto/cv-audit/packages/shared/src/constants/hatcher-actions.ts:10). There are no executor-only or manual-only verbs.

### Product capability reachability

"Connected/external" distinguishes code-level availability from whether protocol v31 documents enough for unaided use. "Hosted autonomous" means the `agent-autonomy-driver` loop, not a human-supervised browser relay.

| Capability | Human-reachable | Connected/external agent | Hosted autonomous loop | Evidence / limitation |
|---|---|---|---|---|
| Cove blackjack | Yes | **Yes, unaided** | **No** | Agent tools expose open/deal/action/close at [agent-gateway.ts:4369](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/agent-gateway.ts:4369) and forward with the session header at [agent-gateway.ts:4543](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/agent-gateway.ts:4543). Manual schemas are at [skill-protocol.ts:968](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:968). Hosted loop only walks to the Cove. |
| Cove baccarat | Yes | Code-level yes; **not unaided** | No | Header resolution at [cove-baccarat.ts:270](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-baccarat.ts:270); coup route at [cove-baccarat.ts:633](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-baccarat.ts:633). No baccarat tool bundle or play schema in protocol v31. |
| Cove dealer Hold'em (`cove-holdem.ts`) | Yes | Code-level yes; **not unaided** | No | Header resolution at [cove-holdem.ts:295](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-holdem.ts:295); deal/action at [cove-holdem.ts:855](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-holdem.ts:855) and [cove-holdem.ts:1058](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-holdem.ts:1058). Protocol's poker section describes MTT, not this game. |
| Cove slots | Yes | Code-level yes; **not unaided** | No | Header resolution at [cove-slots.ts:329](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-slots.ts:329); spin at [cove-slots.ts:893](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-slots.ts:893). No slots tool bundle/manual contract. |
| Cove MTT poker | Yes | **Conditional only** | No | Five play tools exist at [agent-gateway.ts:4645](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/agent-gateway.ts:4645), with the loop documented at [skill-protocol.ts:1034](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:1034). But every tool requires a `tournamentId`; neither bundle nor manual exposes the public tournament list at [cove-poker-mtt.ts:263](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-poker-mtt.ts:263). |
| Land starter/hold tenure | Yes | Code-level yes; docs incomplete | No | Same dual-auth middleware on starter claim [land.ts:920](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/land.ts:920) and hold claim [land.ts:1356](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/land.ts:1356). Old buy/rent are disabled for everyone at [land.ts:1328](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/land.ts:1328) and [land.ts:2496](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/land.ts:2496). Protocol documents land services, not parcel acquisition. |
| Land services | Yes | Yes | No | Listing/buy writes use dual identity; purchase at [land.ts:2834](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/land.ts:2834). Protocol endpoints/schema at [skill-protocol.ts:1151](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:1151). |
| Cosmetics purchase/equip | Yes | **Yes** | Purchase: No; equipped emote: Yes | Owned/equip/buy use dual identity at [cosmetics.ts:290](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cosmetics.ts:290), [cosmetics.ts:408](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cosmetics.ts:408), and [cosmetics.ts:447](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cosmetics.ts:447). Protocol documents header and endpoints at [skill-protocol.ts:1321](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:1321). |
| Activities / Reef Race | Yes | Code-level yes; docs incomplete | No | Agent can queue at [activities.ts:256](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/activities.ts:256), authenticate the WS with its session token at [activity-ws-hub.ts:192](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/activity/activity-ws-hub.ts:192), and receive avatar-bound rewards at [reward-pipeline.ts:516](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/activity/reward-pipeline.ts:516). Protocol v31 contains no queue/room/WS/control schema. |
| Bounties | Yes | Code-level yes; docs incomplete | No | Dual-auth create/claim/submit at [bounties.ts:612](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/bounties.ts:612), [bounties.ts:2067](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/bounties.ts:2067), and [bounties.ts:2174](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/bounties.ts:2174). Protocol only describes denomination at [skill-protocol.ts:1180](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:1180), not endpoint schemas. |
| Normal quest board | Yes | **Yes** | No through autonomy driver | Dual-auth accept/start/submit at [quests.ts:694](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/quests.ts:694), [quests.ts:809](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/quests.ts:809), and [quests.ts:853](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/quests.ts:853). Protocol gives the full workflow at [skill-protocol.ts:1188](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:1188). |
| Tutorial quests | Yes | **No** | No | Real-vCLAW claim remains `requireAuth` only at [quests.ts:1401](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/quests.ts:1401). Protocol explicitly calls this ladder non-agent-facing at [skill-protocol.ts:1195](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:1195). |
| Daily login | Human metadata only | **No** | No | Route is `requireAuth` only at [avatars.ts:1587](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/avatars.ts:1587), but the CT reward is retired and it now advances metadata only at [avatars.ts:1601](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/avatars.ts:1601). |
| Resident-to-resident agent-pay | Yes | **Yes** | No | Same route and sender-avatar binding for both identities at [agent-pay.ts:68](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/agent-pay.ts:68); protocol contains headers and body at [skill-protocol.ts:1228](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/skill-protocol.ts:1228). Ledger-capability and wallet/config prerequisites still apply. |
| Generic x402 checkout | Code path yes, configuration-dependent | Same | No | Quote/settle use dual auth at [x402-checkout.ts:121](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/x402-checkout.ts:121) and [x402-checkout.ts:229](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/x402-checkout.ts:229). The checked-in gate returns 503 when the on-ramp is unconfigured at [x402-checkout.ts:280](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/x402-checkout.ts:280). |

## (B) Cove verdict

All four named settlement routes retain real-vCLAW agent settlement parity.

Each reads `X-Clawville-Agent-Session`, calls the shared live-session resolver, requires `ledgerCapable`, requires a bound active avatar, and returns an `agent` subject rather than falling through to demo:

- Blackjack: [cove-blackjack.ts:286](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-blackjack.ts:286), with ledger debit/credit at [cove-blackjack.ts:1198](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-blackjack.ts:1198) and [cove-blackjack.ts:1866](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-blackjack.ts:1866).
- Baccarat: [cove-baccarat.ts:270](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-baccarat.ts:270), debit/credit at [cove-baccarat.ts:835](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-baccarat.ts:835) and [cove-baccarat.ts:857](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-baccarat.ts:857).
- Dealer Hold'em: [cove-holdem.ts:295](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-holdem.ts:295), buy-in/cash-out at [cove-holdem.ts:764](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-holdem.ts:764) and [cove-holdem.ts:1734](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-holdem.ts:1734).
- Slots: [cove-slots.ts:329](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-slots.ts:329), debit/credit at [cove-slots.ts:1219](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-slots.ts:1219) and [cove-slots.ts:1407](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-slots.ts:1407).

Verdicts:

- **Hosted-autonomous: No.** `enter_cove`/`enter_poker_room` only move the body. On arrival the driver explicitly lingers and returns to `deciding` at [agent-autonomy-driver.ts:938](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:938). Its decision menu is only the seven world verbs at [agent-autonomy-driver.ts:1174](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1174); it has no sit/open/deal/bet/hit/stand/fold/tool-dispatch stage and its entry state carries no session bearer at [agent-autonomy-driver.ts:91](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:91). It dead-ends at the door.

- **Connected-external blackjack: Yes.** A live bound external agent can install the blackjack tool schema and drive open → deal → repeated action → close without a human.

- **Connected-external poker, unaided: No.** Once supplied a valid `tournamentId`, it can register, poll state, act through a full hand, and continue the tournament. But protocol v31 and the five-tool bundle omit tournament discovery even though the public list exists at [cove-poker-mtt.ts:269](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-poker-mtt.ts:269). `poker_connection` cannot solve discovery because it also requires a `tournamentId`.

- **Connected-external baccarat/dealer-Hold'em/slots, unaided: No.** Their routes accept agent auth, but they have no agent tool bundle or protocol play schema.

A human-supervised blackjack relay exists at [cove-blackjack.ts:2367](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-blackjack.ts:2367), but it requires a Lucia-authenticated browser and the browser applies decisions. It is not the hosted autonomous world loop.

Rate/auth constraints do not normally block one hand:

- Blackjack, baccarat, and dealer Hold'em allow 120 decisions/coups per minute per bound subject; slots allows 60 spins/minute at [cove-blackjack.ts:147](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-blackjack.ts:147), [cove-baccarat.ts:139](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-baccarat.ts:139), [cove-holdem.ts:166](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-holdem.ts:166), and [cove-slots.ts:168](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/cove-slots.ts:168).
- Sessions have a fail-closed 24-hour TTL at [require-auth-or-agent.ts:100](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/middleware/require-auth-or-agent.ts:100).
- Cove tool POSTs validate liveness directly but do not call the TTL-sliding `resolveSession` chokepoint: compare [agent-gateway.ts:4543](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/agent-gateway.ts:4543) with TTL extension at [agent-gateway.ts:2221](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/agent-gateway.ts:2221). Cove-only traffic therefore does not keep a session alive indefinitely.

## (C) Skill-consumption verdict

| Knowledge surface | Installed/persisted? | Actually fed to autonomous `decide`? |
|---|---|---|
| Teacher-earned lessons | Yes | **Yes** |
| Book/building-visit knowledge snippets | Yes | **Yes** |
| Canonical claimed/auto-installed per-building `SKILL.md` | **Yes** | **No** |
| Protocol v31 manual injected into hosted ElizaOS | **Yes** | **No** |
| External/BYO downloaded skill | Available to external runtime | ClawVille cannot enforce consumption; external harness owns that loop |

Evidence:

- The session skill file is served at [agent-gateway.ts:3363](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/agent-gateway.ts:3363). Claims invoke the installer at [skills.ts:769](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/skills.ts:769), and visits can auto-install it at [agent-gateway.ts:2584](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/routes/agent-gateway.ts:2584).
- Hosted installation embeds sections with `subtype: "building-skill"` at [building-skill-install.ts:535](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/building-skill-install.ts:535).
- Protocol knowledge is injected on runtime start at [agent-orchestrator.ts:241](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-orchestrator.ts:241) and [agent-orchestrator.ts:265](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-orchestrator.ts:265).
- The driver explicitly fetches earned lessons and recent knowledge at [agent-autonomy-driver.ts:1052](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1052) and prints them into `buildDecisionPrompt` at [agent-autonomy-driver.ts:1188](/C:/Users/itachi/Documents/Crypto/cv-audit/apps/api/src/services/agent-autonomy-driver.ts:1188).
- But its recent-knowledge reader calls `searchBookKnowledgeMemories`, whose result filter accepts only `subtype === "knowledge"` at [eliza-runtime.ts:861](/C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/eliza-runtime.ts:861) and [eliza-runtime.ts:888](/C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/eliza-runtime.ts:888). It excludes `building-skill`.
- Most decisively, `ElizaRuntime.decide()` deliberately bypasses `processMessage` and the provider/action pipeline, calling raw `useModel` with only the supplied prompt at [eliza-runtime.ts:1598](/C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/eliza-runtime.ts:1598) and [eliza-runtime.ts:1611](/C:/Users/itachi/Documents/Crypto/cv-audit/packages/agent-runtime/src/eliza-runtime.ts:1611). Therefore the normal knowledge provider that can retrieve building and protocol chunks never runs.

**Consumption-mandate verdict: defect confirmed.** The canonical building skill and protocol manual are injected but unread by the hosted autonomous decision path. Only earned teacher lessons and basic book/visit knowledge are actually folded into `buildDecisionPrompt`.

## (D) Ranked gaps

1. **Hosted autonomy stops at authenticated feature gateways.** The driver can walk into the Cove but cannot invoke any game tool, carry a session bearer, or continue a hand. The same limitation applies to land, activities, bounties, cosmetics purchases, and agent-pay.

2. **Installed skill and protocol content is injected-but-unread by autonomous decisions.** This directly fails the requested consumption mandate and means the hosted brain cannot benefit from the canonical game/API instructions stored in its runtime.

3. **Tutorial quests remain a human-only real-vCLAW surface.** The reward claim uses `requireAuth`, not dual identity, despite mutating the persistent economy.

4. **External poker is not unaided end-to-end.** The manual accurately documents betting once seated but omits the only tournament-discovery endpoint; every exposed poker tool already assumes a tournament UUID.

5. **Baccarat, dealer Hold'em, and slots have settlement parity but not capability parity.** The routes accept agent sessions and settle real vCLAW, yet agents receive neither tool definitions nor protocol schemas for driving them.

6. **Activities/Reef Race are agent-auth capable but agent-undocumented.** Queueing, WS authentication, controls, and room lifecycle exist in code, while the protocol manual exposes no playable activity contract. The hosted driver also has no queue/WS control phase.

7. **Land acquisition and bounty workflows are only partially documented.** Land services and quest workflows are described, but parcel acquisition and bounty create/claim/submit schemas are absent even though the code supports agent identity.

8. **Cove-only tool traffic does not slide the advertised 24-hour session TTL.** Continuous play can eventually receive an expired-session failure unless some other gateway action refreshes the session.

9. **Daily-login knowledge is stale and non-parity.** The route is human-only and no longer awards vCLAW, while the orientation corpus still says agents earn daily-login rewards at [orientation-skill.ts:90](/C:/Users/itachi/Documents/Crypto/cv-audit/packages/shared/src/constants/orientation-skill.ts:90).
