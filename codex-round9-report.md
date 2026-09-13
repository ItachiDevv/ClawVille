Round 9 is implemented and locally committed. Nothing was pushed.

- `b1219717` — `feat(cove): table room round 9a — spectate binding to live cash tables`
- `aa693331` — `feat(cove): table room round 9b — seated play, Deal button removed`

Verification:

- Build passes.
- Web TypeScript remains at the 12-error baseline.
- Web tests remain 52 pass / 4 baseline failures.
- API TypeScript passes with zero errors.
- Five-minute polling observation produced no errors.
- Live play: 200 vCLAW buy-in, automatic dealing, fold and call/check paths exercised, queued 202 leave, 190 vCLAW returned.
- Required screenshots committed.
- No backend, schema, WebSocket, or MTT changes.

Full findings and evidence: [codex-round9-report.md](C:\Users\itachi\Documents\Crypto\cv-cove-3d\codex-round9-report.md)

The pre-existing dirty worktree changes were preserved and excluded from both commits.