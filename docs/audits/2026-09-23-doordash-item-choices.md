# DoorDash item selection and customization conversation

Last Audited: 2026-09-23. Status: local acceptance passes; deployment verification pending.

## Founder clarification

The founder identifies choosing items and customizations as the awkward part of the conversation. The earlier natural-menu release is production source `0b88e5c2`. Its documented limitation requires a complete choice set in one reply. This follow-up addresses that limitation.

## Plan and constraints

Keep one bounded, transient customization draft per configured operator. Bind it to the exact restaurant, menu, item, and quantity. Keep accepted selections by vendor group and ask for the next missing choice. A clear replacement changes that group only. Unknown, conflicting, or unsupported requests require clarification before a cart mutation.

A draft assembled across replies reaches an item review after its required choices are valid. Show the accepted selections and ask whether to add the item. Optional changes remain available at this stage. Accept a narrow completion reply only for a current review-stage draft, then refresh and revalidate options before adding. A complete initial explicit add can retain its existing direct behavior. This item review is separate from the later human payment confirmation.

An unfinished draft must not appear to be included in a quote for the previous cart. A total request must explain that the draft is not added, without treating the request as permission to add it. An explicit whole-cart clear also removes the pending draft. A narrow current-turn request to skip, cancel, or forget that item clears only an existing draft through the current private cart action. It preserves the actual cart and its quote; model-authored cancellation text alone is insufficient.

Refresh vendor item options on each follow-up and validate retained selections against the current groups, identifiers, and limits. Expired state, a new restaurant/menu/item, and failed explicit item selection must not reuse a previous item's choices. Check concurrent discovery and detail requests before any cart write. Preserve an omitted quantity without confusing it with an explicit new quantity.

Keep the existing thirty-minute lifetime, bounded state, ephemeral vendor replies, and conversation-memory redaction. Do not retain raw conversation fragments, catalogues, prices, or vendor data in permanent memory. Preserve the single-operator capability gate, human-only final payment, raw confirmation, explicit tip, quote fingerprint, caps, preview revocation, and mutation locks. Do not retry an uncertain vendor mutation.

Private action descriptions supply the model's choice-follow-up instructions. The canonical private-operator exception in `GameFeatures.md` keeps this utility out of Nori and public agent manuals. This task does not widen public world scope or change the Hatcher executor. Protocol remains 71 unless the implementation crosses that boundary.

PARITY: human path: owner avatar chat; agent path: the same owner-bound preparation bridge. The customization draft binds to the configured operator and exact vendor item. Final payment remains human-authorized.

## Team and verification

Team `dd-item-choices`: root coordinates documentation and release; `dd_natural_impl` owns the option/session/operator implementation and reconciles findings; `dd_conversation_map` owns private action instructions and model integration; `dd_natural_review` supplies independent regression cases and adversarial review. Fresh reviewer `dd_choices_final_audit` independently checks the final diff and reconciliation.

Acceptance requires independent tests for separate replies, explicit replacements, negations, unknown modifiers, missing groups, quantity changes, scope changes, expiry, races, vendor failures, and unchanged payment authorization. Model-driven checks use synthetic menu/options data through the actual action dispatch path. They do not place a new order or establish live vendor inventory. Release follows local checks, staging verification, and normal production promotion.

## Findings and evidence

- Baseline pending state stores an item and quantity but no accepted group selections. Each follow-up resolves only the current reply and discards valid partial choices.
- The baseline response requests every required choice in one message. Vendor replies are correctly absent from persistent model history, so the server must retain the bounded draft.
- The independent baseline test file reports two passes, eight failures, and thirty assertions on `582819d6`. It reproduces lost partial selections, an ignored unknown positive customization, stale drafts after item/discovery changes, and an awaited option-read race that writes restaurant A while the current context points at restaurant B. All vendor and database boundaries are synthetic.
- Initial independent reconciliation passes 25 tests and 138 assertions. A fresh review identifies two additional issues: a model-supplied quantity could differ from the displayed review, and unrelated selections could clear an unresolved exclusion in the same group. A changed count now requires another review. Option-specific unresolved blocks preserve exclusions; split correction replies must store their accepted choice together with block removal.
- Two bounded real-model runs use `qwen3.6:27b` on the staging hosted-user inference route. Both retain white bread, replace it with wheat, retain large and provolone, accept No Mayo at review, and add exactly one synthetic item after "add it." The ninth greeting causes no action. The eighth repeated No Mayo request causes a clarification, not another action or a claimed mutation. The initial evaluator incorrectly requires CART for that redundant request. The diagnostic run records the sanitized application reply in ignored evidence; the revised evaluator accepts safe clarification only with unchanged final state and no unsupported mutation/payment claim.
- The model probe uses the real runtime/action dispatch and production resolvers, with a synthetic cart bridge. It does not call the live operator service, vendor CLI, database, or payment actions. Mocked-CLI integration tests cover the real operator bridge. The first runs load the local probe bundle into staging application `19fbd1e7`; they do not establish deployment of the new application source.
- Required nested vendor sub-options retain the existing supported-default behavior. Missing required nested defaults require clarification. This change does not add an unrestricted parser for arbitrary nested customizations.
- Final fresh review reports APPROVED after independent isolated runs: 149 tests and 566 assertions across options, operator, session, and adversarial dialogue; 16 probe-evaluator tests also pass. The complete targeted record comprises 405 passes, zero failures, and 2,700 assertions across 19 files. These counts include the earlier isolated unchanged suites; overlapping reviewer runs are not added again. API and runtime typechecks, strict probe typecheck, and the nine-task production build pass. Eight build tasks use valid cached results; the changed API bundle rebuilds.
- The final frozen-source real-model probe passes all nine turns with nine generations in 18.24 seconds. `qwen3.6:27b` serves every turn. The exact final selection is wheat, large, provolone, and No Mayo, quantity one, with one synthetic add. The repeated request causes safe clarification and no mutation. Bundle SHA256 is `158b6d4a66af2178bec6474c224f3a739bdec6887e3537103ee4e8d163cc85d0`. This loaded bundle runs on staging application `19fbd1e7`; the new application deployment remains separately unverified at this checkpoint. Temporary probe files are removed from the host and container afterward.
- Local evidence stays in ignored `.local-evidence/dd-item-choices-20260923/` and `.local-evidence/dd-item-choices/` inside the registered worktree on itachi222. Release evidence follows below.
