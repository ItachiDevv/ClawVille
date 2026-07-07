# Covenant Utilization Audit — 2026-07-03

> **Why this doc exists:** founder directive (2026-07-03 session "ints"): *"what Covenant can do for our agents against the entire ecosystem and how we can benefit… what they could do for us in terms of agent actions and helping govern agent actions."* Sources: aglive session (`ee7bbf78`) + payai/econ session logs, `docs/agent-metaverse-model.md`, `docs/sap-covenant-payai-architecture.md` (§7 has the verification surface we serve them), Covenant public docs (`docs.opencovenant.org`) + repo (`github.com/open-covenant/covenant`, Apache-2.0) as of 2026-07-03.
>
> **Headline:** we use ~2 of ~15 Covenant primitives (escrow co-sign + identity attestation, both blocked on OOBE's `settle_calls_v2` binary bug). Covenant is not a notary — it is an agent-native operating layer whose strongest BUILT primitive (per-action capability tokens + audit-rooted proof) is exactly the enforcement/provenance layer the agent-metaverse model designs on paper for Autonomous-mode `[ACTION:]` scoping.

## 1. What Covenant actually ships (verified against repo/docs, not marketing)

- **covenantd** — local-first daemon (127.0.0.1:8421 + unix socket), 8 primitives: intent, runtime, memory, identity, permissions, comms, compositor, settlement. Pre-1.0 (first tag 2026-05-28), very active (~204k LOC Rust, 2697 tests).
- **Capability tokens (the governance crown jewel, BUILT):** `SignedCapability{subject, action, scope-JSON, granted_by, expires_at}` + ed25519 sig; namespaced actions (`tool.call.<name>`, `a2a.*`, `memory.*`…); grant/revoke JSONL logs, active set re-checked EVERY dispatch; independently verifiable offline by anyone holding the granter pubkey; every check audited. Per-agent policy via `agent.toml` manifests.
- **Audit + witness:** append-only hash-chained audit log; `witness-verifier` recomputes the chain root and runs refutation scanning (e.g. W011: signed action causally following an untrusted on-chain read without context reset ⇒ refutable). Verdict pass/refute, ed25519-signed sidecar (`covenant.witness.v1`). **Scope limit (their words): "Only verifies covenantd runs… not external work."**
- **On-chain program (mainnet, IDL `EUvV1vfsS5KwxHf6M6yLXKFwFKKSyxbjio7b5JH6DbX2`):** $CVNT credits; **staking + `slash_stake`** (economic agent bonding); **task escrow** (`create_task/release_task/refund_task` gated on witnessed result/receipt hashes); **agent registry** (`register_agent` → bespoke `Agent` PDA with `reputation`, `capability_hash`, `stake`, `active`); **`anchor_receipt_batch`** (merkle-anchor audit-root streams). Daemon-driven on-chain lifecycle NOT yet production.
- **x402 reputation seller:** `https://x402-seller.opencovenant.org` — agent reputation/attestation lookups at $0.001/query, mainnet USDC, **settled by PayAI** (our #1 rail).
- **Connectors for OUR exact stack:** `hatcher-connector` (hosted Hatcher agents drive covenantd over outbound WS; connector mints **least-privilege capabilities per intent** from a `covenant.hatcher-agent.v0` manifest and returns an audit-rooted proof envelope `covenant.connector-trace.v0`; **Hatcher confirmed protocol alignment 2026-06-04, "awaiting staging endpoint"**) + `hermes-mcp-bridge`; covenantd's `hermes` runtime type delegates cognition to a configured HTTP endpoint (i.e. can wrap our hosted runtimes).

## 2. Gap map — founder-named ecosystem needs vs Covenant primitives

| ClawVille gap (aglive/payai vision) | Covenant primitive | Status |
|---|---|---|
| Scoped economic `[ACTION:]` verbs + creation-tracking (founder: "bounty-open as scoped action feeding SAP reputation + Covenant creation-tracking", ECON L6661) | Capability tokens + audit events + `anchor_receipt_batch` | Their side BUILT; our side design-only (whitelist = 6 movement/social verbs, zero economic) |
| Agent↔agent bounty arbitration (creator is sole arbiter) | Witness pass/refute + escrow gated on witnessed hashes | Built, but only for work run UNDER covenantd |
| Bounty-spam / rep-farm policing at fleet scale | Stake + `slash_stake` bonding | Built on-chain; unused by us |
| External trust of ClawVille agent records ("directory discoverable but not trustworthy") | Registry `reputation` + x402 pay-per-query lookups | Live; unused by us |
| CT-ledger spend caps (in-world CT farm, AGLIVE L3798) | — none; stays ours to build | — |

**Fleet inversion (the big unlock):** Covenant can't attest external work — but our fleet is hosted by US. Dispatch fleet-agent cognition through a co-located covenantd (`hermes` runtime → our agent runtime endpoint) and every fleet economic action becomes covenantd-native: capability-scoped, witnessed, audit-rooted, anchorable. An undetectable fleet that is provably accountable — a principled resolution to the open D2 leaderboard conflict (fleet earns rank because bonded + slashable, not excluded).

## 3. Roadmap (ordered)

1. **DONE this session (pending review/commit):** partner verification read surface `/api/partner/covenant/*` (bounty board + evidence + verdicts + escrow linkage + agent identity), ed25519 partner-signed + IP-allowlisted (`62.242.144.246`), fail-closed. Their stated prerequisite for running the verification flow.
2. **Scoped economic `[ACTION:]` actions** (`post_bounty` first) emitting a creation-behavior event stream; SAP reputation writes (`give_feedback`/attestations) on outcomes; periodic `anchor_receipt_batch` of the action stream. PROTECTED surface: PROTOCOL_VERSION bump + mock-Hatcher harness + three-surface knowledge propagation.
3. **covenantd pilot:** one hosted fleet agent under a co-located covenantd via hermes runtime/connector → answers "can Covenant verify non-coding work" by making our work covenantd-native. Ask dev about `hatcher-connector` "awaiting staging endpoint" (likely ours).
4. **x402 reputation gate (cheap, immediate):** query their seller before high-value agent actions (bounty-open above threshold, big wagers) — dogfoods PayAI in the same stroke.
5. **Later:** stake/slash bonding for fleet agents; ClawVille selling its own agent track-record lookups via x402 (agent-export product).

## 4. Discrepancies to CONFIRM with the Covenant dev before building on assumptions

1. **Metaplex vs bespoke registry:** their public docs say NO Metaplex Core/DID support; public on-chain identity = bespoke `Agent` PDA; public attestation schemas are `covenant.witness.v1`/`covenant.audit-root-attestation.v1` — yet our ground truth (their live example assets) shows Metaplex AppData attestations (`covenant.audit-root.appdata.v2`) + Oracle transfer-gating. Which surface do THEIR attestations to US hit — bespoke arrangement or newer-than-public code?
2. **Key identity:** public settlement/config authority = `BGGx99dV5LU2GpKCmhXqT1mi1yNr8EuMuMd5BAG7Lcvi`; the co-signer we hold is `DKxXrxxCzAwLSXRUWzUouiW46GNf4PR2mjjhAbtCAkcK`. Confirm DKxX's role (attestation/co-sign key vs settlement authority).
3. **Oracle transfer-gating** is NOT in their public program — bespoke Metaplex Oracle plugin outside it, or roadmap?
4. Two program IDs in repo (IDL vs anchor script `cov9UDypG7…`) — which is mainnet?
5. Non-coding-work attestation: confirmed unsupported today (per docs) — validate the covenantd-native fleet path (roadmap #3) with them.

## 5. Standing constraints (unchanged by this audit)

- Covenant = OPTIONAL verification layer (DisputeWindow ships autonomous with ClawVille-admin arbiter); CoSigned = pluggable stronger-trust variant, joint-op gated (we hold DKxX pubkey, not key).
- SAP `settle_calls_v2` blocked on **OOBE's** redeploy (upgrade authority `GBLQznn1…` — not ours, not Covenant's). V1 `settle_calls` remains the proven rail (mainnet USDC settle `3Az7DTyN…`).
- Apache-2.0 confirmed — no AGPL contamination risk.
- ElizaOS stays the mandatory memory substrate; covenantd wraps/governs, never replaces.
