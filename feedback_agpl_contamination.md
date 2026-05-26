---
name: feedback-agpl-contamination
description: "Never copy code from AGPL-licensed repos into ClawVille. AGPL forces all of ClawVille (incl. wallet/custody/API) open to anyone who hits the site. Read for ideas, never paste a line. Permissive only (MIT/ISC/Apache/BSD)."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 742c7462-6ff1-4984-8aaa-fb4823665b40
---

**Rule:** Reject any dependency or code copy from a GPL/AGPL-licensed repo. Permissive licenses only (MIT, ISC, Apache-2.0, BSD-2/3, MPL-2.0 is a fuzzy edge — file-level copyleft, usually OK as dep but ask).

**Why:** ClawVille has custodial Solana wallets, envelope-encrypted KEKs in Cloudflare, a token economy with real money flow, partner integrations ('scape portal, Milady sideload), and commercial/investment intent. AGPL specifically closes the "SaaS loophole" — running the code on a server users hit over the network counts as distribution. Anyone playing clawville.world would have legal right to demand the full source of every package, including wallet code and deploy scripts, AND redistribute it. Deal-killer in any fundraise or M&A diligence. GPL is nearly as bad — only safer if you never expose it over the network.

**Concrete trigger from 2026-05-17:** `michaelkolesidis/cherry-charm` (Three.js R3F slot machine, perfect stack match) is AGPL-3.0. Tagged as "READ ONLY — DO NOT COPY" in casino plan. Use as visual/animation reference only; write reel-spin animation from scratch.

**How to apply:**
1. BEFORE proposing a repo as a code source: run `gh repo view <owner>/<repo> --json licenseInfo` and check the result.
2. If licenseInfo is `gpl-*` or `agpl-*` → reference only, never copy. State this explicitly to user.
3. If licenseInfo is `null` (no LICENSE file) → also unusable. "No license" = all rights reserved by default. Treat as unusable until upstream clarifies.
4. If repo is on npm, also check the package.json `license` field via `curl https://registry.npmjs.org/<pkg>` — sometimes npm license differs from GitHub LICENSE file; npm field is what gets installed.
5. Permissive (MIT/ISC/Apache/BSD) → safe to depend on or copy with attribution.
6. Gray zone (clean-room reimplementation of an AGPL idea): possible in theory, but for a solo developer, the cleanest path is "don't read the source at all — work from the README/screenshots/spec." Note the boundary in commit message.

Related: [[project-casino-slots]]
