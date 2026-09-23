# DoorDash conversational menu follow-ups

Last Audited: 2026-09-23. Status: implementation and acceptance in progress.

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

This utility uses the existing ElizaOS actions. It does not add a Hatcher action, widen access, or advertise DoorDash through public agent manuals. The avatar chat layout change requires the existing connection-manual and Nori documentation gates. Protocol 70 adds generic guidance to preserve multiline replies and lists. That protected manual change requires fresh staging onboarding, signed partner, and hosted-runtime verification. No coupling rule is weakened.

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

## Acceptance limits

This change does not establish a new paid order, alter vendor checkout timing, or provide general natural-language understanding for arbitrary instructions. Required item choices still request a complete set in one message; independent partial-choice accumulation needs explicit correction and conflict semantics.

| Follow-up | Owner | Completion condition | Review deadline |
|---|---|---|---|
| Retain item customization choices across separate replies | knowledge-orientation with agent-protocol-partner review | Scope transient choices to the exact operator/store/menu/item. Resolve replacements and contradictory choices explicitly. Prove no stale choice reaches another item or cart. Until then, request the complete choice set in one message. | 2026-09-29 |
