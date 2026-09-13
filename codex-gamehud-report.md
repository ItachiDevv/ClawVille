Implemented and committed on `feat/cove-3d-holdem` in two parts:

- `904978a4` — fairness-truncated public live state
- `75b1adfb` — seat badges, action playout, settlement narration, blinds, and bet presets

Key result: `publicActionLog` ends strictly before the synthetic human fold, so no future bot actions leak. Human all-in hands resolve terminally and cannot remain in progress.

Verification:

- API tests: 84 passed
- API TypeScript: 0 errors
- Web Hold’em tests: 14 passed
- Full web tests: 52 passed; 4 pre-existing verifier failures
- Web TypeScript: exactly the 12-error baseline
- Root build: 9/9 packages passed
- Local production browser verification: desktop, 390×844 phone, and 820×1180 iPad emulation; no page errors
- Real-iPad safe-area behavior remains unverified
- Existing unrelated worktree changes were preserved

The protocol manual mentions settled Hold’em events but does not document the enriched in-progress response shape. Per instruction, `skill-protocol.ts` and `PROTOCOL_VERSION` were untouched.

Full implementation and verification record: [codex-gamehud-report.md](/C:/Users/itachi/Documents/Crypto/cv-cove-3d/codex-gamehud-report.md).