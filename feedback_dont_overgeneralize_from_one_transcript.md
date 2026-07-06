---
name: dont-overgeneralize-from-one-transcript
description: Don't infer "no worker can do X" from "this one transcript failed at X." A single failed session is not representative of all workers — others may have succeeded via paths you haven't traced.
metadata:
  type: feedback
---

When reading a single session transcript that shows a worker failing at task X, do not conclude "no worker can do task X" or "task X must be impossible without Y." A single transcript proves only what happened in that session.

**Why:** On 2026-05-20, I read the morning's ClawVille Claude session transcript and saw it repeatedly fail to deploy to ClawVille prod (it was hitting the wrong IP, `5.78.99.224` instead of `87.99.142.34`). I told the user *"None of today's deploys actually fired against prod"* and *"there's no path through the public docs that resolves `<PROD_VPS_IP>` to the right value"* — generalizing from one bad session to all workers. Both statements were wrong. The user immediately produced evidence: a debug-bot message from ~15 minutes earlier confirming a successful cache clear on `87.99.142.34`. Another worker had reached prod fine, likely via inline IP from the user or via the deploy script reading `.env.deploy`.

**How to apply:**
- When you find a failed transcript, say "this session failed because X" — not "no session can succeed at X."
- Before claiming a capability is universally absent, check: are there other transcripts? Is there a private memory file? Is there a script that abstracts the secret? Did the user paste the value inline elsewhere?
- The presence of a gitignored env file (`.env.deploy`, `.env.local`) or a wrapper script (`scripts/deploy/*.sh`) is strong evidence that workers DO have a path to the secret — find the path before declaring it impossible.
- Related: [[deploy-infrastructure]] — the deploy-infra file documents the specific IPs and incident this lesson came from.
