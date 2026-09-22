# Coupling registry schema

Last Audited: 2026-09-22. Phase 1 contains the first fourteen coupling rules in the approved taxonomy.
Asset-version, animation, static-ban, CODEOWNERS, and later plan phases remain separate.

Each coupling file has YAML frontmatter in its JSON subset, between `---` lines.
The strict JSON parser rejects comments, aliases, implicit types, unknown keys, and unsupported values.
Required keys: `id`, `mechanism: coupling`, `owner`, `status: active`, `trigger`, `requires`, and `selector`.
The filename must equal `<id>.md`. The original fourteen IDs must remain present.
`trigger` is a nonempty array of repository-relative globs. Glob syntax permits `*`, `?`, and complete `**` segments.
`requires` is a nonempty array of nonempty alternative groups. Groups use AND; paths within each group use OR.
A requirement needs different, nonempty resulting content in the evaluated diff. Deletions and unchanged files never qualify.

Selectors: `any`; `architecture` (new route/service files, all other declared triggers); `new-env` (new literal env keys);
`executor` (changed dispatch/execute methods or shared action menu); `protocol-version` (changed or missing version).
Only the named `protocol-increase` assertion is supported. It requires one literal integer declaration before and after, with a strict increase.
Literal env keys include dot and quoted-bracket syntax. Dynamic env access requires human review.
Executor selection relies on class method indentation; unrecognized method endings compare the full source conservatively.

The only escape is an exact standalone `[skip-nori-update]` line in the final head commit message.
It waives only `gameplay-change-updates-nori-knowledge` and emits a visible warning.
Substrings, previous commit messages, and escapes on other rules never waive requirements.
Use it only when the gameplay trigger has no change relevant to Nori; explain that reason in the commit and review it.

CI checks PR merge-base to immutable PR head. Push and reusable deploy calls check event.before to event.after.
Manual dispatch requires an explicit full `coupling-base-sha`. No HEAD-parent fallback exists.
Missing history, zero SHA, equal endpoints, unknown events, stale index, or a mismatched checkout fail closed.
The checkout uses the exact evaluated head and full history. No API token or external package is needed.

Local: `bun scripts/ci/run-coupling-gates.ts --base <full-sha> --head <checked-out-full-sha>`.
Tests: `bun test scripts/ci/run-coupling-gates.test.ts`.
Index: `bun .claude/gates/build-index.ts`.

The registry and runner remain reviewed code. A user who can change CI can weaken it; these gates do not provide tamper-proof governance.
Changed documentation does not prove correct documentation, runtime installation, human-agent parity, or a successful signed staging harness.
