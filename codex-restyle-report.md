Implemented and committed as `08262d8d`:

`feat(cove): table room visual round — cove-themed HUD restyle, 12s visual decision timer, seated look-around`

Verification:

- Production build: 9/9 packages pass
- API TypeScript: 0 errors
- Web TypeScript: exact 12-error baseline
- Web tests: exact baseline, 52 pass / 4 verifier failures
- Headed Chrome: full hand played, timer and yaw verified
- All eight required viewport orientations pass
- `E` and Back to Cove routing verified
- Real-iPad safe-area remains physically unverified

Full evidence: [codex-restyle-report.md](C:/Users/itachi/Documents/Crypto/cv-cove-3d/codex-restyle-report.md)

Screenshots: [idle](C:/Users/itachi/Documents/Crypto/cv-cove-3d/restyle-idle.png), [live timer](C:/Users/itachi/Documents/Crypto/cv-cove-3d/restyle-live-timer.png), [yawed](C:/Users/itachi/Documents/Crypto/cv-cove-3d/restyle-yawed.png).

Compiled and rendering locally—needs your visual sign-off.