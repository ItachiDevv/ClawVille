# Phase 1 coupling enforcement review

Last Audited: 2026-09-22. Team: cv-dd-coupling.
Implementer/reconciler: independent_review. Adversarial reviewer: final_release_audit. Scope reviewer: adjacent_sessions.
This diff follows core cleanup commit `cbb647ad1a5a7c9b9e1a301c9f1b2ea2ec43fde6`.

The earlier fixBounty request included immediate implementation of the coupling runner.
The first fourteen coupling taxonomy rows now have registry files, a strict runner, and a separate CI job.
The scope ends at agent-connect-updates-docs. Later asset, animation, static-ban, and governance phases remain separate.
Current path coverage includes shared action constants, agent-substrate services, the compatibility type shim, casino engines, connection UI, and avatar login routes.
Nori's shared orientation source can satisfy its knowledge requirement because the town-guide template includes that source.

The runner reads changed content from both immutable commits. Existing, empty, deleted, and rename-only documents do not satisfy an update.
Action menu changes require a changed manual and a strict literal protocol integer increase.
Malformed registry data, missing original rules, unknown selectors, unavailable history, zero bases, and stale generated indexes fail closed.
The sole escape is an exact final-commit line `[skip-nori-update]`; it affects only the Nori rule and emits a warning.

PR checks use the merge-base of immutable event base and head SHAs.
Push and reusable deployment checks use the complete event.before/event.after range.
Manual dispatch requires an explicit full coupling-base-sha. No final-parent fallback can hide earlier feature commits.
The fourth stable job name is `coupling documentation contracts`; deployment callers require it through the existing Gates dependency.
Remote master protection still needs four-context activation and proof after authorization succeeds.

Independent review found two false negatives during implementation.
UTF-8 decoding could collapse distinct binary model bytes; lossless blob identity now preserves the change.
Unrecognized method indentation could bypass the executor selector; it now compares the full source conservatively.
Both independent reproductions passed after these corrections.

Local verification on itachi222:

- Combined behavioral and independent suites: 21 passed, zero failed, 104 assertions.
- Real Git fixture covers multiple commits, source deletion, and rename handling.
- Actual cleanup range 10575a98c4d954bcfd809c1d86aa4c9169942151 to cbb647ad1a5a7c9b9e1a301c9f1b2ea2ec43fde6: exit zero, fourteen rules, nine triggered.
- Actionlint passed all three deployment/Gates workflows. git diff --check passed.

Fixtures remain within the registered worktree under .coupling-test-fixtures and use guarded finally cleanup.
Only that directory's explicit .gitignore belongs in Git; no fixture repository belongs in the commit.
The .claude directory is ignored in this checkout, so the release coordinator must stage the exact registry, schema, index, and index-builder paths.

These checks enforce coupling, not documentation truth or live parity.
Human review still checks meaning, and signed staging/runtime probes remain release requirements.
Users with permission to change CI can weaken this code; it is not tamper-proof governance.
No remote configuration, deployment, commit, or push ran from this implementation task.

PARITY: the same changed-file and knowledge requirements apply to human and agent feature changes.
