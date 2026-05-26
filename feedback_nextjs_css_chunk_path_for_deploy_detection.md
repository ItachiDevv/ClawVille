---
name: nextjs-css-chunk-path-for-deploy-detection
description: "Next.js App Router serves CSS at /_next/static/chunks/*.css, NOT /_next/static/css/. Grepping the wrong path makes deploy detectors hang while the bundle is live"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3c19235e-7fee-4160-8ca6-2586a33b60dc
---

When polling for a Next.js (App Router) deploy to land, the CSS chunks are served from `/_next/static/chunks/<hash>.css`, NOT `/_next/static/css/<hash>.css`. The latter pattern is the old Pages-Router default.

**Why:** During the casino slot modal redesign on 2026-05-20, I armed a Bash detector that polled `curl https://clawville.world/casino | grep "pt-spin-btn\|--pt-amber"` waiting for the new Predict Terminal tokens. The HTML never matched because the new CSS is in a chunk file, not inlined. The deploy went live in ~4 min as expected, but my detector kept polling for 7+ minutes — the user pinged "dude it's been a while" before I realized the bug.

**How to apply:**
- For a Next.js App Router deploy detector, grep the HTML for `/_next/static/chunks/[^"]+\.css` to extract chunk URLs, then fetch each and grep for your tokens
- Or grep the served HTML for an inline style class name that you KNOW is rendered server-side (only works if the new component renders in SSR; modal components like SlotScreenModal that only render when `open=true` will NOT appear in the static HTML)
- For Pages Router, both `/css/` and `/chunks/` paths exist; check both
- General rule: when wiring a "deploy ready" detector, fetch the live page ONCE and verify your grep pattern matches the EXISTING bundle before arming the loop. A pattern that doesn't match the BEFORE state will never match the AFTER state either.
