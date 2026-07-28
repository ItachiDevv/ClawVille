# Recovered: CLV-swap live-executor impact-probe rework (NOT MERGEABLE AS-IS)

Recovered 2026-07-28 during the worktree cleanup sweep from `cv-sap-sdk`
(branch `wip/oracle-helius-depth`, base commit `65976116`, ~2026-07-14),
where it sat UNCOMMITTED. Nothing in this change ever reached a pushed branch.

What it does (from the in-file contract rewrite): live clip sizing stops
trusting DexScreener pool depth entirely — each clip starts at a configurable
$25 probe cap (`CLV_SWAP_JUPITER_PROBE_USDC`, tune-down only), and Jupiter's
own `priceImpactPct` gates/shrinks the candidate before signing; the accepted
quote is reused for /swap and must still clear the independent
oracle-tolerance floor. `planClips`/`sizeClipMicro` stay unchanged for
dry-run/advisory callers. + tests, env docs, money-rails/ARCHITECTURE notes.

The 7 files on this branch are the session's working tree VERBATIM — they are
~2 weeks BEHIND current staging in every other respect and 5 of 7 CONFLICT
with it (`git apply --3way` evidence). The exact intended diff against its own
base is `clv-swap-impact-probe-vs-base-65976116.patch` in this directory.

To land it: reconcile onto current staging, then the FULL dark-money-path
ceremony (CLV_SWAP_EXECUTE seam untouched, Codex adversarial review) — the
swap executor is a Codex-gated money surface (see CLAUDE.md tokenomics env
rules). Do NOT merge this branch.
