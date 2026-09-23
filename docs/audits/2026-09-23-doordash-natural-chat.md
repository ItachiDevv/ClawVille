# DoorDash conversational menu follow-ups

Last Audited: 2026-09-23. Status: production deployment and the observed browser checks pass at `0b88e5c2`; physical iPad and sustained device-performance acceptance remain open.

## Founder request

The founder confirms that a paid DoorDash order succeeded. This request improves natural chat-to-menu language. That confirmation is user evidence for the earlier order; this change does not place another order.

## Source findings and intended behavior

- The prior trigger-phrase repair remains in the actual ElizaOS prompt. The defect is not a missing `similes` injection.
- The menu action and bridge reject omitted restaurant arguments despite an existing selected restaurant. A contextual request such as “What drinks do they have?” must use an unambiguous current selection.
- Restaurant results show eight entries but retain more entries internally. An ordinal must address the exact displayed list, including unnamed rows, and must never use a hidden result.
- A new search must prevent the previous restaurant from receiving a later ambiguous “their menu” request. Expired or ambiguous references ask for a restaurant without launching an unrelated vendor search.
- Search results use numbered lines. Menu results use item-name bullets and a short next-step question. Menu numbering must not imply unsupported item-number selection.
- The avatar chat bubble must preserve line breaks so these results remain readable in the actual UI.
- The options matcher must distinguish “Mayo” from “no mayo,” preserve explicit vendor choices such as “No Mayo” and “Not Toasted,” and ask when an exclusion cannot be represented safely.

## Constraints

Keep the single-operator capability gate, human-only submit, raw requester confirmation, quote fingerprint, caps, preview revocation, and mutation locks. No checkout authorization changes.

Keep vendor data outside persistent conversation history. Context remains bounded, user-scoped, in memory, and expires after 30 minutes. Restaurant references must match what the user saw. A failed menu retrieval must preserve the existing cart.

This utility uses the existing ElizaOS actions. It does not add a Hatcher action, widen access, or advertise DoorDash through public agent manuals. The avatar chat layout change requires the existing connection-manual and Nori documentation gates. Protocol 70 adds generic guidance to preserve multiline replies and lists. Protocol 71 adds scroll guidance for the final viewport correction. These protected manual changes require fresh staging onboarding, signed partner, and hosted-runtime verification. No coupling rule is weakened.

PARITY: human path: owner avatar chat; agent path: the same owner-bound agent preparation bridge; cart preparation resolves to the configured operator. Human-only final payment authorization remains unchanged.

## Verification

- The independent real `processMessage` test reproduces the contextual-menu failure before implementation: 17 pass, one expected failure. It uses scripted model output, real action handlers, and accumulated persisted memories. This establishes dispatch and persistence behavior, not real-model language quality.
- The initial options suite reproduces 14 failing negative-language cases. Independent review also reproduces excluded contractions, punctuation variants, and a stale restaurant after a failed menu request. Permanent regressions cover the corrections.
- Final isolated validation on itachi222 passes 464 tests and 3,288 assertions across 22 files with Bun 1.3.11. Independent review initially passes 178 tests and 1,300 assertions, including ignored diagnostic fixtures; its full-menu follow-up passes 61 tests and 557 assertions. These totals overlap and must not be added.
- API, agent-runtime, and web typechecks pass. The final production build passes all nine tasks. `git diff --check` passes. Local evidence lives in the ignored `.local-evidence/dd-natural-chat-20260923/` directory in the registered audit worktree.
- Beverage queries use a bounded name heuristic. This is not a complete vendor category inventory. Food names such as Coffee Cake, Tea Cookies, and Watermelon Bowl do not match the tested beverage aliases.
- The first synthetic real-model probe reaches its 25-second deadline before the router's configured 60-second attempt deadline. The revised probe retains hard turn and overall limits and reports safe phase timing. It uses the actual hosted-user inference route and actual `processMessage`, with synthetic memory and read-only vendor bridge. It has no real vendor, cart, database, or payment access.
- The first seven-case model run reports five passes and two parameter failures. Safe diagnostics establish that the drinks request retains `storeName: "the second one"`, which the production resolver correctly maps to the selected restaurant. This is an over-strict probe expectation, not a restaurant-context defect. The full-menu request emits `query: "full menu"`; that does expose a real food-filter defect. Acceptance requires explicit general-menu normalization and a fresh real-model run.
- Router usage counters identify `qwen3:14b` as the response model. The first three turns each take about 61 seconds; later turns take about 0.44 seconds after route failover. These observations do not establish a provider root cause or faster production responses. No router setting changes.
- Staging workflow `35834631474` passes all four CI gates, migration, and its deployment trigger for `1f4cc72b`. Actual container replacement and browser acceptance remain pending at this checkpoint. Final real-model acceptance remains pending.
- The final synthetic model run passes all seven cases through the real handler and hosted-user route. The loaded bundle includes the `62a80e83` full-menu correction; the probe runs in the `1f4cc72b` staging container. It verifies language dispatch with synthetic data, not live vendor inventory.
- Staging CI `35835630875` rejects `62a80e83` before migration or deployment: three older quest race tests borrow an arbitrary avatar and fail when no other suite leaves one. The same-SHA PR run passes. A test-only correction creates an owned user/avatar transactionally, preserves all race assertions, waits for all writers, and cleans up only exact fixture records. Independent review and the no-database run pass; PostgreSQL CI remains the acceptance requirement.

## Acceptance limits

Both CI runs for `4ff18b31` pass all four gates, including the PostgreSQL quest race cases. Staging run `35836361202` also passes migration and the deployment trigger.

A disposable public agent enters staging through the normal browser invitation flow. Its join-created avatar initially has no hosted runtime; the supported customization route provisions that runtime. A fresh live chat reply contains two lines, and the rendered bubble uses `white-space: pre-wrap` and `overflow-wrap: break-word`. No DOM content or application state is injected.

The first eight-viewport browser pass finds a real landscape defect: at 844x390 the chat panel begins at y=-81 with the reconnect notice visible. Other required dimensions fit, and input/Send/Close measure 44px high. The final correction limits the panel to the available viewport and lets only the message area shrink.

Final staging API `yvtwz7snaghxifkjhyxknffu-084227651637` and web `ju0n3sddhll3cuhbrspt4muy-083035815484` report `SOURCE_COMMIT=19fbd1e741b2bf8f6db2def0291c3369dfbb4e2c`. The earlier API container is absent. Stable-container onboarding passes 14/14, and the signed Hatcher harness passes 14/14. The temporary signer is absent from both deployment configuration and runtime configuration; the temporary key is deleted. The final hosted probe passes 16/16. The final hosted consumption probe passes 125/125, including canary consumption and fixture disposal. Evidence: `onboarding-final.log`, `hatcher-final.log`, `hosted-final.log`, and `hosted-consumption-final.log` in the local evidence directory.

The first final onboarding attempt occurs during overlap between API containers `19fbd1e7` and `4ff18b31`. It passes five checks, then returns 403 on appearance PATCH; signed cleanup also fails. Source review identifies two possible overlap mechanisms: public lazy restore removes ledger authority, and challenge nonces remain process-local. The logs do not prove individual request routing. The retry after old-container removal passes the appearance check and all fourteen checks. This is an operational acceptance failure, not evidence for changing either authorization gate.

Read-only inspection identifies one exact orphan from that failed attempt. An authorized compare-and-set expires only bot `d4938ba8-3f1a-4672-9e1b-e98c9d53fd37`, clears its bearer hash, and disables autonomy. No rows are deleted. After the signer-free API replacement, readback proves the same fixture remains expired with no bearer hash or autonomy enrollment. Its public active entry and world body are absent; session status returns HTTP 410. Evidence: `orphan-inspection-result.log`, `orphan-cas-result.log`, and `orphan-post-restart-verification.log`.

The final world-chat browser pass uses an actual eight-line reply and the actual reconnect notice at all eight required phone/tablet orientations. The panel fits, and input/Send/Close remain 44px high. At 844x390, the corrected panel spans y=16 to y=326. Table chat also passes all eight orientations with an actual eight-line reply and reconnect notice. Its landscape panel spans y=70 to y=370. Collapse, Reconnect, input, and Send measure 44px high. At 844x390, the message area has a 111px client height and 338px content height; its bottom scroll position is 227px. These browser checks do not establish physical iPad safe-area behavior or sustained device FPS.

The table message area scrolls from 227px back to 0px through normal wheel input. Collapse dismisses the table panel, and Close dismisses the world panel. Browser viewport overrides are cleared. The disposable browser account logs out through the normal UI; signed disconnect returns `disconnected:true` and public session/body absence. Its local credential file is deleted. Durable fixture account history remains; no account, avatar, or wallet rows are deleted.

PR #299 merges normally at 2026-09-23 08:55:22 UTC after all four required checks pass in run `35839655714`. Production workflow `35839892211` passes all gates, migration, and deployment. At 09:05 UTC, production API `ebnatuxblgp4q0antoca9swk-085818690437` and web `ds7hoho685ire522lz3hie2j-085818713889` both report `SOURCE_COMMIT=0b88e5c25335e7472a8b8eba5bb14b1c6e8b4e05`. Both former `7473e809` containers are absent. API health reports `ok` and the exact source; runtime environment is production and test signer configuration is false.

The production public clawville-play manual returns HTTP 200, version 71, and `sha256:016cc3c59a9918b85241cabf129673df93f483c28e535642c87e64a05c73d7f3`. This task adds no schema changes; schema remains synced. Staging application source remains `19fbd1e7`. The final documentation-only checkpoint does not change either application's source SHA.

Production browser checks at 09:05-09:09 UTC confirm that `/game` renders buildings, avatars, and the town sign. Guest Nori opens and gives an actual reply locating the Bounty Board on the right side of the Quest + Bounty Pavilion behind the town sign. Close removes the panel. The console reports only the pre-existing Phantom extension error, `Cannot redefine property: ethereum`; no application exception is observed. Camera input is attempted, but this check establishes no quantified zoom or FPS result. No signed-in production DoorDash, cart, or payment request occurs. The eight-viewport chat checks above remain staging evidence only. Physical iPad safe-area and sustained device-performance acceptance remain separate and pending.

This release does not establish a new paid order, alter vendor checkout timing, or provide general natural-language understanding for arbitrary instructions. Its original item-choice limitation required a complete set in one message. The subsequent implementation and acceptance record is [item choices across replies](2026-09-23-doordash-item-choices.md).

| Follow-up | Owner | Completion condition | Review deadline |
|---|---|---|---|
| Retain item customization choices across separate replies | knowledge-orientation with agent-protocol-partner review | Follow-up implementation scopes choices to the exact operator/store/menu/item and adds explicit correction and review stages. Current acceptance and release evidence: [item-choice audit](2026-09-23-doordash-item-choices.md). | 2026-09-29 |
