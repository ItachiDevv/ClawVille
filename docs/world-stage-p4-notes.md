# World Stage P4 Implementation Notes

## Anchor drift

- DRIFT: spec cites pre-P3 `WorldStageRoot.tsx` line/snippet anchors; live is the landed P3 root with unified capability controller and Kelp slot; requirement applied as a fourth empty `activity` slot plus destination-aware navigation against the landed roles.
- DRIFT: spec cites P3's frozen protocol value 41 in historical passages; live is 42; requirement reserved for P4b as the mandated 42→43 bump.
- DRIFT: spec cites four live v42 references in `docs/hatcher-integration-spec.md`; post-P3 live is five current references plus the append-only version ledger; requirement applied as v43 on every current reference and an appended v43 ledger clause while preserving v42 history.
- DRIFT: spec cites an existing `apps/web/.env.example`; live has only the repository-root `.env.example`; requirement applied as the whitelisted new `apps/web/.env.example` containing only the frozen probe-gate row and comment.

## Decisions

- The frozen v16 specification is authoritative. No design alternatives will be introduced.
- All work remains local on `feat/world-stage-p4-activities`; origin will not be touched.

## Slice gates

- Documentation mandate: PASS — source/copy SHA-256 `8383A8671904C3C39E732EF9D71CBD32F06E81AB59B317BB4648FB5909758CEB`.
- P4a: PASS — `bun run build` exit 0; `bun run typecheck` 12/12, 0 errors.
- P4b: PASS — protocol 42→43 propagated through manual, derived orientation pointers, test pins, Hatcher live references/history, presence, peer rendering, and canonical docs; 13 focused tests pass; build exit 0; typecheck 12/12.
- P4c: pending.
- P4d: pending.

## Final gates

- `bun run build`: pending.
- `bun run typecheck`: pending.
- Diff-scope gate: pending.
- New and inherited tests: pending.
- Production runtime verification: pending.
