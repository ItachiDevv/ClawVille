# dd session audit — 2026-09-22

Audit base: `origin/staging` `10575a98`, isolated worktree `cv-dd-audit` on **itachi222**. The audit does not place orders or change live accounts. Historical production claims below describe transcript evidence, not a fresh production check.

## Evidence and coverage

Primary transcript: `C:\Users\itachi\.claude\projects\C--Users-itachi-Documents-Crypto-ClawVille\b4fbbf4a-9a8c-47ea-a87d-a5dcc906e610.jsonl`. References `dd:L` mean physical JSONL line numbers. The recorded interval is **2026-09-16 21:08:11 UTC through 2026-09-20 21:26:20 UTC**. The last filesystem write is September 21. These are different facts. Parsing covered all records: 2,770 user-role records, 5,161 assistant-role records, plus metadata. Most user-role records contain tool results or automated messages; they are not founder requests. Compaction summaries are secondary evidence.

Eight subagent transcripts were parsed under the adjacent `b4f.../subagents/` directory. Their last reports, and relevant intermediate findings, were inspected. Canonical document headers, the domain registry, and knowledge/protocol known traps were read before current-code review.

| Subagent transcript | Scope / evidence |
|---|---|
| `agent-add-backup-hunt-4164f4deb6cbe246.jsonl` | Lost-session recovery; no recovered implementation proves a shipped DoorDash feature. |
| `agent-add-reconstruct-8f21df4f75201936.jsonl` | Recovery dossier; line 212 retracts the claim that the integration spec did not exist. The original search preceded spec creation. |
| `agent-add-spec-c042d30c49153070.jsonl` | Integration design; line 267 verifies the correct branch base and warns against copying a stale canonical document. |
| `agent-add-impl-1e52e18ef1cbe2b3.jsonl` | Phase 1; line 561 reports 99 passing tests, uncommitted implementation, and no live verification. |
| `agent-add-money-review-3a0abe811408bf38.jsonl` | Phase 2 money review; line 226 explicitly identifies missing database coverage for transaction, TTL, and concurrency behavior. Its approval does not prove these paths. |
| `agent-a1ebd5ae5bb2fd895.jsonl` | Full seeded-knowledge audit; line 311 lists incorrect facts and missing discovery surfaces. |
| `agent-a292b3243f5fdcaad.jsonl` | Manual audit; line 325 lists two incorrect claims and seven discovery gaps. |
| `agent-accde7e604e1be682.jsonl` | Independent building/teacher/coordinate table; line 165 establishes the reference map. |

## Founder request and acceptance matrix

`Source present` means the current source implements the requested behavior. It does not assert a current live or visual pass.

| UTC date / dd line | Request or complaint | Historical disposition / current acceptance evidence |
|---|---|---|
| Sep 16 / 12 | Recover the lost DoorDash session after directory consolidation. | Recovery agents produced a dossier. They found no surviving original implementation. The session inferred transcript retention, not a code overwrite. |
| Sep 16 / 251, 278 | Use the Linux CLI, dedicated beta GitHub identity, and documented environment variable. | `DDCLI_GITHUB_TOKEN` documentation exists in `ARCHITECTURE.md:1405`; binary install script and captured help exist. Secret values are excluded from this report. |
| Sep 16 / 408, 430 | Explain WSL and verify token export. | Historical operational assistance. Current token validity requires an authorized live read; no validity claim follows from source. |
| Sep 16 / 529 | Restrict beta use to the founder account and card. | `doordash-operator.ts:69-111` intersects one operator ID with admin IDs and requires a bound avatar. Agent capability cannot submit. Source present. |
| Sep 16 / 623 | Human-only submit; two orders/day; approved caps; ask tip after real fees; chat-only discovery; skip protocol bump. | Defaults are 2 orders/day, $75/order, $150/day; submit counts tip. Preview renders fees then asks for tip. Explicit permission explains the initial protocol exception. Tip authorization remains defective: DD-A01 below. |
| Sep 17 / 1264 | Seed staging and perform both required setup steps. | The transcript records staging setup, then live response-shape defects. A green unit suite did not establish CLI compatibility. |
| Sep 17 / 1490, 1571, 1627 | Fix staging that appeared to identify itself as production. | Session distinguishes host/cloud-init naming from app environment. Deployment runbook correction exists. Root audit owns a fresh host/environment check. |
| Sep 17 / 1887, 1909 | Test authenticated staging directly; reset test-account password if needed. | Authorized at that time. Historical transcript contains plaintext test credentials in a tool result at 1928. Do not reproduce or reuse them. |
| Sep 17 / 2271, 2296, 2317 | Correct delivery-account/default-address mismatch. | `defaultAddressId()` anchors search to the saved address. On lookup failure without cache, it still performs unanchored search; current source can revive wrong-city behavior (DD-A03). Personal address omitted. |
| Sep 17 / 2382 | Fix narrated actions; inspect actual beta repository documentation. | Commits `7dbf627c`, `d46fafc5` add action guidance and similes. Wrapper fixes envelope and name variants. Session retracts unsupported cuisine-search claim. |
| Sep 17 / 2735 | Implement Phase 2 after compaction. | `50b7fb02` adds cart, preview, confirmation, submission. Source retains operator gate, durable caps, claimed-row concurrency, and ambiguous-outcome no-retry behavior. |
| Sep 17 / 4303 | Finish outstanding item. | Subsequent transcript adds missing cap/bridge checks. Historical tests include failures and repairs, not uninterrupted success. |
| Sep 18 / 5095, 5270 | Determine sandbox availability; prepare realistic end-to-end order. | Session says vendor sandbox is absent. A real founder-authorized order appears later. This audit does not independently validate vendor sandbox support. |
| Sep 18 / 5426, 6130, 6177 | Enable the actual founder account, use public name, promote for the demo. | Historical operational change; current source gate remains account-specific. Root owns current configuration verification. |
| Sep 18 / 6233, 6304 | Clarify login and special order wording. | Operational response. No credentials are copied into this report. |
| Sep 18 / 6333 | Chat label showed email prefix; switch to requested avatar. | Current `agent-display-name.ts` and `avatar-chat-bar.tsx:75` derive the label from auth username. Avatar choice was an account-data write; source alone cannot establish the current avatar. |
| Sep 18 / 6499 | Reply took about two minutes and exceeded chat space. | `e3345b16` adds concise persona directive; `abcb3bf3` adds heartbeat runtime warm-up. Source present, but the warm-up is asynchronous and cannot guarantee zero first-turn delay. |
| Sep 18 / 6556 | Natural 'hungry/available' request should find open Wawa. | `5714bd05`; generic search combines restaurant results with deliverable convenience-store results. Current tests cover Wawa and scheduled-only exclusion. |
| Sep 18 / 6619 | No numeric store-code demo; custom hoagie choices; explain final confirmation code. | Server context resolves store/item names; option groups require choices; preview supplies code and asks tip. Current source includes plural/joined-word matching from `abcb3bf3`. |
| Sep 18 / 7369 | Nori falsely says all bounties disappeared and sends users to Pearl. | `6f0c9e89` and later knowledge passes identify the Pavilion, not a teacher. Current orientation line 173 preserves this. |
| Sep 18 / 7369, 7577 | Follow-up replies remain excessively long. | `a4bc8279` makes DoorDash action output replace persona prose. `e3345b16` and `3845c5b0` add concise style without dropping action tags. Ordinary owner replies retain a 1000-token ceiling, so style remains probabilistic. |
| Sep 18 / 8027 | Explain confirmation code; automatically warm owner agent. | Preview explicitly asks for code+tip. `avatars.ts:1593-1634` starts owner runtime from existing heartbeat, throttled to five minutes. Source present. |
| Sep 18 / 8072, 8090 | Repeat order instructions; investigate screenshot. | Historical order monitor at 8110/8117/8123 transitions previewed → submitting → submitted. Screenshot text is not inferred when image content is unavailable. |
| Sep 18 / 8173 | Fix remaining issues and coordinate with bountyFix2. | Cross-session split changes over time. Final dd ownership: Nori prompt/collider, outer lots, race self-copy/requeue, knowledge, labels, wager closure. |
| Sep 18 / 9877 | Continue autonomously; investigate regressions in git history. | Some defects were old omissions; the race cleanup was a later regression. Independent history audit establishes commit-level provenance. |
| Sep 18 / 14219 | Label should be '<username> agent'; approve SAP drop; explain lobbies/date; adapt map. | Label helper is wired. SAP and map belong to bountyFix2. October 18 was an arbitrary deferred review date, admitted at 14319. |
| Sep 18 / 14322 | Close old Bumper Shells lobby shells and mark them closed. | Historical claim at 14762: rows 184/187 become system state `cancelled`, reason `closed: never created on-chain`; tombstone monitor watches late chain creation. Root/history audit verifies current watcher. |
| Sep 19 / 14830 | Verify Nori no longer points to Pearl for bounties. | Session first admits no live answer check at 14844, after earlier global success claims. It then reports live answers at 14902. |
| Sep 19 / 14906 | Audit all seeded knowledge; verify proximity; explain code fix. | Three independent subagents find numerous additional errors. `c9878d02`, `cbe6ad01`, `1882a583`, `8524418e` correct knowledge and REST movement bounds. Current `/move` uses world dimensions at `agent-gateway.ts:2495-2496`. |
| Sep 19 / 16068 | Checkpoint before restart. | Session checkpoint and peer restart messages exist. |
| Sep 19 / 16978 | Authorize live Nori questions. | First seven-question test exposes three wrong answers. Version 64 retest records corrected answers; details below. |

## Current defects and limitations

### DD-A01 — P1: tip validation does not identify the human's tip

`apps/api/src/services/doordash-confirm.ts:111-124` accepts any matching number, including both cent and dollar representations. `doordash-operator.ts:704` treats this as money authority. A code-masked pure execution on September 22 returned true for all of these:

| Human message | Model-requested tip | Result |
|---|---:|---|
| `confirm ACDEFG, add 4 garlic knots` | 400 cents | accepted |
| `confirm ACDEFG, tip 4` | 4 cents | accepted |
| `confirm ACDEFG, tip 400 cents` | 40000 cents | accepted by helper; separate caps may refuse |
| `confirm ACDEFG, tip $4` | 400 cents | accepted, expected |

The first two violate the founder's explicit tip choice even within ordinary caps. Existing tests cover digit masking and substring boundaries, but omit semantic and unit ambiguity.

### DD-A02 — P1: cart edits leave old confirmations valid

`doordash-operator.ts:479-563` changes cart contents without invalidating outstanding preview rows. Preview stores cart UUID and total, but no basket identity (`618-626`). Submit compares only total (`782`). Therefore an equal-price replacement can retain a valid old code. Human and bound-agent preparation share the operator cart. Current tests do not exercise this sequence. Source review establishes the missing invalidation; a mocked end-to-end reproduction must precede the patch.

### DD-A03 — P2: address failure revives unanchored search

`defaultAddressId()` returns null after a first failed address lookup. Search then calls the CLI without an address and skips nearby stores. The source itself documents the vendor's Cupertino fallback. This can reproduce the founder's wrong-location symptom. Refusing until an address is available avoids a misleading empty result. Cached stale addresses also survive lookup failure beyond TTL; fresh address verification remains a separate operational need.

### DD-A04 — P2: recorded verification overstates coverage

The historical phase-two test set omits the database-backed submit state machine, caps under concurrency, TTL, and cart identity. The money reviewer states this explicitly. Source tests at `doordash-operator.test.ts:353-415` cover early refusal, not a successful claim/submission path. Current cleanup requires adversarial mocked/database tests, not another assertion of existing green counts.

### DD-A05 — documentation drift

`routes/doordash.ts:10` still says '0 (not yet shipped)'. `doordash-operator.ts:807` says zero real submits, despite the historical September 18 order. Adjacent comments still say no real submit response was captured. `ARCHITECTURE.md:1412` lists submitting/submitted usage, but code also counts ambiguous failed rows. These facts need explicit correction without inventing a fresh production metric.

## Historical claim failures and repaired tests

- Phase 1 reported **99/99** (`dd:913,1097,1119`) while actual CLI responses used an unmodeled MCP envelope. Those tests mocked the assumed shape. Later source normalizes the envelope.
- Action prompt example leaked the gated DoorDash verb. Tests failed **39 pass / 2 fail** at `2553`; the example changed to the always-available balance action; `2571` records **41/41**.
- Phase 2 recorded failures at `3395,3423,3438,3499,3774,3826,3900,4295,4537`, then repaired suites. These are not current failures merely because they appear in a log.
- Wawa/options changes initially failed suites at `7011`; subsequent `7159,7164` report clean relevant counts.
- Nori prompt reviews required changes at `9049,9099`, then approved at `9170`. Server collider review rejected missing canonical documentation at `9660`, approved at `9693`.
- A broad API test run still had **94 failures** at `10042` and `10221`. Narrower successful runs do not erase that evidence. Root must classify current isolated failures.
- Land showroom review rejected at `10815/10820`; documentation and CI coverage were added before approval at `10893`.
- Race reviews rejected at `12353/12433`; later approval at `12475`. The transcript records old-code failure checks rather than only new-code passes.
- Initial wager cancellation was rejected at `12907`; session shipped log throttling first. The later founder-approved monitor/cancel change was rejected at `14509`, repaired and approved at `14578`.
- Knowledge version 63 was rejected at `15411`; repaired approval at `15530`. Runtime tests still failed at `15628/15631`, then passed at `15635/15639`. Version 64 review rejected at `17862`; repaired suites at `17975`.
- Global claims at `13826,13967,14095,14214,14827` precede the later full knowledge audit. At `14844` the session admits it had not heard Nori's bounty answer live. Treat those global claims as overstated.
- The seven-question production test had wrong directions and teacher attribution, plus incorrect Hold'em control advice (`170xx-17216`). Version 64 retest at `18658-18704` records corrected replies. The final summary at `18775` says 7/7.
- Required hosted-runtime probe was omitted for release #291 and initial version 64 staging work, admitted at `18775`. Peer `clawAgents` reports **78/78** at `18406` on **41954718**, which contains version 65 as well as version 64. This is combined-code evidence, not a clean standalone version 64 probe.

## Cross-session evidence and regression causes

- `dd:550` warns the primary `main-desktop` tree at `754f2bfd` was **428 commits behind** staging. The stale `ARCHITECTURE.md` diff was approximately +1050/-1046. The team explicitly re-applied only new rows to an up-to-date worktree. This proves a near-miss, not a source overwrite by this session.
- `dd:695,710,731` contain contradictory spec-existence reports and their resolution. The file appeared after the first search; a shared Windows junction also linked plan directories. Timing and shared paths explain the contradiction.
- `dd:8860` transfers cove refresh/placement work to bountyFix2. `9544` transfers mobile-control overlaps. Later dd takes land showroom and race work explicitly.
- `dd:13826` distinguishes the 36 original showroom lots from a later 20-lot outer ring; an earlier fix never covered the later ring. The race self-copy instead traces to a later July cleanup change.
- `dd:14827` acknowledges the SAP drop caused approximately four minutes of bounty-route 500s because migration preceded compatible API deployment. The independent bounty audit owns details.
- `dd:18331,18376,18406` records hosted-runtime probe failure from a pre-existing fleet halt, operator clearance by another session, then a successful rerun. Do not mistake a blocked probe for a runtime-code defect.
- `dd:18800` explicitly says another session rewrote shared `MEMORY.md` from an older copy. This is evidence of a memory overwrite, not proof that the product-code fixes disappeared.

## Remaining acceptance boundaries

The audit preserves current source checks, historical executed outputs, assistant assertions, and peer assertions as separate evidence classes. No live account-data, delivery-address, token-validity, or completed-order claim follows from this report. Root owns the final production comparison, browser checks, remaining seeded-knowledge review, and independent review of cleanup patches. The DoorDash hardening patch must preserve one-account access, human-only submit, durable caps, single-use claims, and no automatic retry after an ambiguous charge.

## Cleanup patch evidence — September 22

The local patch addresses DD-A01–DD-A03 and DD-A05. Before edits, the actual bridge with a mock database/CLI failed four adversarial cases: equal-price agent removal, equal-price human addition, incidental item quantity as tip, and dollars mistaken for cents. The unchanged-quote success case passed. The same four cases now refuse without calling vendor submit.

The new quote digest includes cart/store/item/line IDs, quantities, nested option data, fulfillment mode, and delivery destination. It excludes volatile quote ETA and pricing display. The wrapper computes it before removing raw fields, ignores vendor-supplied digests, and returns only the digest. `0068_doordash_quote_fingerprint.sql` is additive and nullable. Legacy previews require a new preview; submitted history does not change. Mutation revocation covers both human and agent previews before sending any cart write. A timeout therefore leaves the old code revoked. A database revocation failure prevents the vendor write. The whole workflow mutex prevents same-process cart edits between re-price and charge. Another environment or the DoorDash app can still change vendor state after the final re-price; this remains an external atomicity limit.

The independent reviewer found seven additional amount ambiguities in the first parser patch. Tests proved them before repair. The parser now requires a complete masked-turn confirmation grammar with explicit tip and units; ranges, corrections, comma amounts, foreign currency, unrelated quantities, and cancellation text refuse. Only straightforward affirmative/polite prefixes are accepted.

Validation so far: database package build passed; API typecheck passed. Fifteen relevant test files ran in separate processes with zero failed files. New flow/fingerprint tests passed 30/30; tip tests passed 32/32; existing operator tests passed 28/28. The wrapper suite passed 26/26 after a raw-option and forged-digest test. The independent reviewer owns the final adversarial verdict and additional tests. These are local results, not deployment claims. Root separately applies and checks migration compatibility in an isolated scratch PostgreSQL container.

The document cleanup also corrects `GameFeatures.md` §19 from the old 5120-unit, ten-slot map to the source-derived 22528-unit, twelve-slot map. Three separate headings still use `18d`; their content is distinct. Renumbering requires a reference audit and is not silently folded into this patch.

The fingerprint review found an additional ambiguity: sorting every nested array could equate ordered vendor data, such as reversed coordinates. Canonicalization now sorts object keys only. All array order remains significant; harmless vendor reordering can require a new preview rather than falsely preserve authorization.

## Independent UI review and Nori parity follow-through

The UI patch passed 99 checks across the guest chat panel, prompt offsets, and touch geometry. The actual production QueryClient sets retries for queries only; mutations do not retry automatically. Nori retries a definitive 401 exactly once after guest bootstrap. The guest endpoint reuses a valid human session. Avatar and canonical auth caches invalidate after bootstrap. Nori now mounts before avatar creation, and touch Close clears movement freeze. Geometry tests cover the four required portrait/landscape device pairs plus narrow and short screens with bottom insets through 44 pixels. These tests do not reproduce real Safari chrome.

The independent source review found an older E5 defect: `/api/chat/system/:slug` accepted only Lucia cookies, with no bound-agent alternative. Generic `talk_to_npc` produced a bubble and did not call Nori. The local cleanup therefore adds a shared system-chat service, authenticated HTTP agent access, a universal `clawville_chat_nori` tool, and the seventeenth in-world action `chat_nori(message=...)`. Protocol documentation uses version 68 with the other cleanup knowledge edits.

Human and agent requests share owner-scoped Nori memory and the existing owner/slug reward cooldown. Agents must pass the shared live-session resolver and exact active-avatar binding. Invalid, expired, unbound, non-ledger, and guest-owned sessions cannot reach cognition. Human guests and humans without avatars retain chat access without real rewards. The service repeats authority and canonical guest/avatar checks after cognition. A failed credit reports zero rewards and awards no XP. Revocation after successful credit suppresses later memory without discarding the original subject's event.

Independent review exposed an action-dispatch risk in the first draft: Eliza executes generated action tags when callers supply services. Nori now receives no executable services for either subject. Avatar/inventory context remains read-only. Only the explicit post-cognition reward path can credit a Nori turn. Reply action tags do not enter the caller's action dispatcher. Root also identified a privacy risk in publishing Nori replies as world chat; the implementation removes that publication because the shared owner room can contain private human conversation.

Hosted action replies enter existing owner memory and the driver’s next-decision `lastLesson` input. The Hatcher client carries the bounded reply as quoted data in the private player message, never public world state or the partner-owned system prompt. Each current session owns its own client observation. The action checks session, avatar, and body identity after asynchronous work. The existing earned-memory deterministic ID now includes the runtime agent ID. Existing rows remain intact; the first repeated lesson can create one new ID after deployment.

Local checks at this report update: shared package build and API typecheck passed; system-chat route tests passed 14/14; hosted action tests passed 8/8, including revocation and public-snapshot privacy; moderation tests passed 8/8; earned-memory collision test passed 1/1; DoorDash fingerprint and independent ambiguity tests passed 35/35. The independent reviewer owns additional malicious-runtime and mid-request revocation tests. The adjacent-session reviewer owns the signed Hatcher wire-consumption check. Staging harness and production verification remain root-owned gates.

The final agent-runtime package build passed. The updated offline Hatcher harness reports 87 PASS / 0 FAIL / 0 SKIP, including seventeen-verb manual/executor parity. Its dummy local database refusals do not verify production persistence. The isolated migration compatibility result comes from root's scratch PostgreSQL transaction: legacy preview/submitted rows retained null fingerprints; repeat application and a new digest insert succeeded, then rolled back.

The adjacent reviewer reports the independent private Hatcher wire test passed 1/1 with 16 assertions. It captures the actual outgoing request after a Nori action and verifies its ephemeral Ed25519 signature. The note enters the sole user message and identical `playerMessage`, not public world state or a system message. A fresh same-agent client does not inherit the note; action tags are removed and the note is capped at 2000 characters. This is an independently reported local mock result, not a staging claim.
