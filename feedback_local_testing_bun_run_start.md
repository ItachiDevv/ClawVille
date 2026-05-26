---
name: local-testing-bun-run-start-is-the-workflow
description: "ClawVille IS tested locally via `bun run start` (production-mode Next.js serving the built bundle). The Iris Xe / \"never run locally\" rule applies ONLY to `bun run dev` (HMR + dev overhead crashes WebGPU). `bun run start` is fine and is the existing workflow — DO NOT propose Coolify-only testing or sandbox-route workarounds."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2a0e75b4-0e15-483b-b64e-f6d46d09f2ac
---

**Rule:** When the user wants to verify a change locally, the path is `bun run build && bun run start` in apps/web (and apps/api if needed). This serves the pre-compiled production bundle on localhost:3000 and does NOT crash Iris Xe — the GPU crash only happens with the dev server's HMR/inspection overhead.

**Why:** The CLAUDE.md kill-the-build invariant says "NEVER run `bun run dev` locally (Iris Xe crash → PC restart)." That rule is specifically about `bun run dev`. `bun run start` runs the static prod bundle and is fundamentally different — no HMR, no React DevTools instrumentation, no source-map dev overhead. User has called this out multiple times ("ive said a million times"); repeatedly conflating the two = burnt patience.

**How to apply:** If user wants to test locally, default answer is `bun run build && bun run start`. Do NOT propose:
- Adding a sandbox/dev test route as a workaround
- "We can only test via Coolify deploys" framing
- Suggesting alternatives to `bun run start`

The Coolify push-deploy-verify cycle is for SHIPPING (staging-first push flow). It is NOT the iteration loop for local verification. Local verification = `bun run start`.

**Bun Windows note:** `bun build apps/api` panics on Bun 1.3.6 Windows per the existing `feedback_bun_windows_build_crash` rule. That's about the explicit `bun build` command on api source. `bun run start` in apps/web invokes `next start` against an already-built bundle — different code path, works fine. Don't confuse the two.

**Workflow:**
1. `cd apps/web && bun run build` (or `bun run build` at root if turborepo wired)
2. `bun run start` — serves prod bundle on :3000
3. Optionally point at staging api via NEXT_PUBLIC_API_URL if local api not running
4. Iterate on the change
5. Once happy locally, push to staging for visual sign-off + browser verify

Set 2026-05-25 after I burned ~3 staging deploys on a 2D modal fix that could have been verified locally in seconds.
