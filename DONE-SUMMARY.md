# Front-door agent connect summary

Commit: `56ab64b8` (`fix(connect): restore one-step agent front door`)

## Changes by file

- `apps/api/src/routes/agent-gateway.ts`
  - Adds `POST /api/agent/connect-token/public` for logged-out, unbound five-minute invitations.
  - Applies strict Zod validation, 5/minute/IP and 25/day/IP limits, and salted fingerprint/IP-prefix tagging.
  - Returns a separate browser-only poll secret, stores only its SHA-256 digest, and keeps anonymous minting free of account/avatar/wallet/ledger writes.
  - On the unchanged `/api/agent/connect` claim, requires the agent's existing `identityKey`, resolves a real non-guest account, provisions/reuses the same default avatar path as `/join`, and carries the proven user/avatar through owner binding, live session attribution, and ticket minting.
  - Fails closed on an existing different owner, without rebinding the agent or issuing a browser handoff.
  - Adds `POST /api/agent/connect-status/public/:token`, authorized by the browser poll secret and minting fingerprint. It returns only `{ connected, enterUrl, expiresIn }`, never the agent bearer/id, and burns the pending handoff after the first successful read.
  - Makes claim expiry race-safe with a bounded 60-second in-progress grace and then adopts the one-use session ticket's expiry. The legacy GET status route cannot inspect or delete public handoffs.
  - Reuses one default-avatar provisioning helper from both `/join` and the public-token claim.
- `apps/api/src/routes/__tests__/agent-frontdoor-connect.test.ts`
  - Covers strict input validation, unauthenticated minting, staging-safe URLs, digest-only poll-secret storage, 5/minute and 25/day limits, identity-key requirement, different-owner rejection, claim/expiry races, fingerprint/secret isolation, real account/avatar binding, one-use polling, and bearer redaction.
- `apps/web/src/app/login/page.tsx`
  - Replaces the paste-a-link form with optional learning focus, one Generate action, the exact copyable instruction `Read this URL and follow the instructions: <connectUrl>`, live countdown/polling, and automatic validated `/enter?t=sess-...` navigation.
  - Cleans up polling on tab changes, regeneration, errors, and unmount.
- `apps/web/src/lib/api.ts`
  - Adds typed public token-mint and browser-secret poll helpers without changing authenticated connect helpers.
- `apps/web/src/components/agent-connect-instructions.tsx`
  - Removes the human-facing skill-manual URL and raw API endpoint, leaving one shared simple three-step explanation.
- `apps/web/src/components/game/agent-connect-modal.tsx`
  - Keeps the authenticated generate/poll flow and aligns clipboard output with the same full one-line instruction.
- `GameFeatures.md`
  - Updates both checked-in section-2 copies with the one-step front-door flow, Last Audited note, and human/agent PARITY path.
- `ARCHITECTURE.md`
  - Documents the additive public mint/poll endpoints, rate limits, browser-secret boundary, real claim-time account/avatar binding, ownership-conflict behavior, expiry grace, and unchanged protected wire.

## End-to-end flow

1. A logged-out human opens `/login?mode=connect`, optionally enters a learning focus, and generates a link.
2. The API creates only an in-memory, fingerprint-tagged invitation plus a separate browser poll secret. No user exists yet.
3. The page shows one instruction. The human copies it into their agent's chat.
4. The agent reads the existing connect skill and claims through the unchanged `POST /api/agent/connect` contract using `connectionToken`, stable `agentId`, and `identityKey`.
5. Claim-time identity resolution creates/reuses a real non-guest user and avatar, binds the agent only when ownership proof succeeds, and mints the existing one-use session ticket.
6. The original browser POST-polls with its private poll secret and matching fingerprint. It receives the `/enter?t=...` URL once, validates it as same-origin, and navigates automatically.
7. The existing `/enter` exchanger atomically consumes the ticket, creates the Lucia session cookie, and routes into the game. No additional human click or pasted return link is required.

## Verification

- `packages/shared`: `bun run build` — passed (`tsc`).
- `packages/database`: `bun run build` — passed (`tsc`).
- `apps/api`: `bun test src/routes/__tests__/agent-frontdoor-connect.test.ts` — 9 passed, 0 failed, 82 expectations.
- `apps/api`: `bun test src/routes/__tests__/guest-economy-guard-coverage.test.ts` — 66 passed, 0 failed, 135 expectations.
- `apps/api`: `bunx tsc --noEmit` — passed with no output.
- `apps/web`: `bunx tsc --noEmit` — passed with no output.
- `git diff --check` — passed (Git emitted only the worktree's normal LF/CRLF conversion warnings).
- Adversarial review — approved after ownership-conflict, Zod-param, expiry-race, and legacy-GET isolation regressions were added.
- Protected-surface check — no `skill-protocol.ts`, partner route/service, auth ticket service, shared partner type, or protocol-manual file changed; `/api/agent/connect` request/response shape is unchanged.

## Not verified here

- No staging/prod push or deployment was performed, per instruction.
- No live external-agent or production-browser visual sign-off was performed. The implementation is locally compiled and test-covered, but still needs the founder's browser confirmation after staging deployment.

---

# Round 2 — in-game connect and login restoration

Implementation commit: `705c5e8c` (`fix(connect): restore in-game logged-out connect`)

## Changes by file

- `apps/web/src/components/game/agent-connect-modal.tsx`
  - Makes the in-game modal the primary connect surface for confirmed anonymous and guest Explore/NPC visitors.
  - Uses the existing public mint and browser-secret poll helpers for logged-out connect, while preserving the authenticated bound mint/GET-poll/bearer flow for logged-in avatar owners.
  - Strictly validates a successful public `enterUrl` through the shared validator, then redeems it in the same tab with `window.location.assign`.
  - Keeps logged-in avatar-less users and explicit Create intent on the existing `/create-agent` explainer; logged-out Connect no longer enters that branch.
  - Adds the in-game login mode, non-overlapping recursive polling, request-epoch protection against late mint responses, and timer/clipboard cleanup on close, cancel, intent changes, and unmount.
- `apps/web/src/components/game/in-game-login-form.tsx`
  - Adds the minimal email/password form backed by the existing `api.login` call.
  - Performs the old-cookie identity sweep before login, preserves guest quest progress, claims guest Cove history, refreshes auth/avatar/agent-session state after the cookie swap, and leaves the browser on `/game`.
  - Keeps failed credentials visible in the modal and allows forgot-password to leave the game; it does not add in-game signup.
- `apps/web/src/lib/auth-transition.ts`
  - Extracts the shared pre-login identity cleanup, post-auth query reconciliation, and guest Cove-history claim used by both the front door and in-game login.
- `apps/web/src/lib/public-enter-destination.ts`
  - Single-sources the fail-closed handoff validator: same origin, exact `/enter`, no credentials or hash, exactly one `t` parameter, and a canonical `sess-` ticket.
- `apps/web/src/app/login/page.tsx`
  - Reuses the shared handoff validator and auth-transition helpers.
  - Awaits auth/avatar/session reconciliation before navigating after ordinary front-door login or signup, preserving the prior stale-auth fix.
- `apps/web/src/app/game/page.tsx`
  - Adds the logged-out banner's in-game **Connect Agent** action and changes **Log In** from a `/login` link to the modal login mode.
  - Leaves **Sign Up** as the permitted exit-only flow.
- `apps/web/src/components/game/sidebar-menu.tsx`
  - Changes the logged-out **Log In** row to open the in-game login mode; the generic **Agent** row continues to open in-game Connect.
- `apps/web/src/components/game/guest-upsell-modal.tsx`
  - Changes **I already have an account** to close the upsell and open in-game login; account creation remains an external signup flow.
- `apps/web/src/stores/game.ts`
  - Extends the connect-modal intent union with `login`, keeping `create`, `connect`, and `login` as explicit surfaces.
- `GameFeatures.md`
  - Updates both checked-in §2 copies: in-game modal is primary, `/login?mode=connect` is secondary, login/connect stay in-world, signup/create remain exit-only, and human/agent parity is documented.

`ARCHITECTURE.md` was not changed in round 2 because no API route or wire contract changed. In particular, protected `POST /api/agent/connect` remains untouched.

## Exact logged-out in-game flow

1. An anonymous or guest visitor remains in Explore/NPC mode and opens **Connect Agent** from the top banner or the sidebar Agent row.
2. The modal confirms auth state, then calls the existing `api.generatePublicConnectToken`; it does not call the authenticated guest-blocked mint.
3. The visitor optionally supplies a learning focus, generates the link, copies the single plain-language instruction, and stays in the world while the modal shows **Waiting for your agent to connect...**.
4. The external agent follows the link and claims through the unchanged `POST /api/agent/connect` contract. Round 1 provisions/binds the real non-guest account and avatar and creates the one-use browser handoff.
5. The same modal POST-polls with the browser-only secret through `api.pollPublicConnectStatus`. The poll never gives the browser an agent bearer or id.
6. On `{ connected: true, enterUrl }`, the client validates the URL with the shared strict validator and calls `window.location.assign('/enter?t=...')` in the same tab.
7. The web `/enter` route redirects the browser to the API exchanger. The API atomically consumes the ticket, sets the Lucia cookie, completes the owner bind, and redirects back to `/game`; the existing game auth/avatar sync lands the visitor as the real avatar.
8. If the visitor chooses **Log In** instead, the email/password form calls `api.login`, refreshes `auth-me`, avatar, and agent-session state in place, and lets the existing game-page sync promote Explore/NPC to the logged-in avatar without navigating to `/login`.

## Redemption mechanism

Shipped mechanism **(a): `window.location.assign`**.

Mechanism (b) is unsafe for this route chain. The same-origin web `/enter` page first returns a 307 redirect to the API `/api/auth/enter` exchanger. A fetch using `redirect: 'manual'` stops at that web redirect before the API consumes the ticket and sets Lucia's cookie; attempting to reproduce the cross-origin redirect/cookie exchange in fetch also risks burning the one-use ticket without a usable browser session. Native same-tab navigation follows the established 307 → API cookie → 302 `/game` path correctly.

## Verification

- `apps/web`: `bunx tsc --noEmit` — exit 0, no output.
- `apps/api`: `bun test ./src/routes/__tests__/agent-frontdoor-connect.test.ts` — 9 passed, 0 failed, 82 assertions.
- `git diff --check` — exit 0; only the worktree's normal LF→CRLF warnings were emitted.
- Final adversarial/React review — approved after fixing stale auth navigation, login-form unmount, background poll, late mint-response, and clipboard-timer races.
- Protected-surface audit — zero `apps/api/**` diff; `/api/agent/connect`, authenticated guest 403, protocol/version, and partner contract are unchanged.
- No `bun install`, push, deployment, or live-browser sign-off was performed.

---

# Round 3 — on-theme connect and complete auth paths

## Files changed

- `apps/web/src/app/game/page.tsx`
- `apps/web/src/components/game/in-game-login-form.tsx`
- `apps/web/src/components/game/agent-connect-modal.tsx`
- `GameFeatures.md`
- `DONE-SUMMARY.md`

## Visual changes

- Restyled the top-bar **Connect Agent** pill from yellow to the cyan/blue gradient accent while preserving **Log In** and **Sign Up**.
- Added **New to ClawVille? Sign up** to the in-game login form without removing **Forgot password?**.
- Added distinct Login and Connect subtitles plus reciprocal **Log in here** / **Connect here** surface links with synchronized modal intent.
- Confirmed the logged-out sidebar and guest upsell already expose both in-game **Log In** and `/login?mode=signup`; no restoration edit was needed there.

## Verification

- `apps/web`: `bunx tsc --noEmit` — exit 0, no output.

---

# Round 4 — magic-connect full world scope

Implementation commit: `a8eca7c7` (`fix(connect): serve full world-scope entry manual`)

## Files changed

- `apps/api/src/services/skill-protocol.ts`
  - Advances `PROTOCOL_VERSION` from 35 to 36.
  - Extends `buildPlayManual` with optional invitation token/TTL inputs, full world orientation, and invited-only human-ticket, identity, wallet, lifecycle, and first-contact guidance.
  - Derives the 10 teaching-building names and ids from `SHOP_BUILDINGS` plus `MAP_LOCATIONS` and keeps the versioned protocol manual authoritative.
  - Makes secret custody explicit: the agent securely stores the identity secret; it relays the avatar wallet recovery secret once for the human to save and never stores that wallet secret in agent config.
- `apps/api/src/routes/agent-gateway.ts`
  - Deletes the bespoke connection-plumbing-only Markdown literal.
  - Serves `buildPlayManual(resolveApiBase(), { connectionToken, tokenExpiresInSeconds })` from the existing token lookup while preserving the 400/410 behavior.
  - Returns the successful manual as exact `text/markdown; charset=utf-8` and computes TTL from one current-time snapshot.
- `apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts`
  - Covers public versus invited composition, exact token/TTL behavior, world-scope markers, all 10 teacher locations, protocol pull, ticket relay, identity/wallet custody, lifecycle guidance, and forbidden outward terminology.
- `apps/api/src/routes/__tests__/agent-frontdoor-connect.test.ts`
  - Locks the live invited route to the staging-safe API base, full world manual, remaining TTL, and Markdown content type while keeping all 9 front-door tests green.
- `apps/api/src/routes/__tests__/agent-paid-surface.test.ts`
  - Updates the protected paid-surface protocol assertion to v36.
- `apps/web/src/components/game/agent-connect-modal.tsx`
  - Reframes the connected state around living in the world, learning from teachers, playing at the Cove card tables, and earning vCLAW.
- `apps/web/src/app/login/page.tsx`
  - Reframes signup completion from starting to learn to entering the world immediately.
- `GameFeatures.md`
  - Updates both checked-in section-2 copies with the unified v36 world-scope magic-connect path and PARITY note.
- `ARCHITECTURE.md`
  - Documents the public alias/internal renderer, staging-safe base resolution, invited-only layers, and unchanged protected wire shapes.
- `docs/hatcher-integration-spec.md`
  - Records protocol v36, corrects the v35 Kelp history, and distinguishes advancing version/hash values from unchanged signed routes/auth and frozen pointer keys/order/shape.

## New served Markdown section headers

```text
## What ClawVille is: the world you are entering
## 1. Connect
## IMPORTANT: relay the magic link back to the human
## IMPORTANT: save the identity key to your config
## IMPORTANT: save the avatar wallet address to your config
## Reconnect, liveness, and disconnect
## First-contact flow
## 2. Pull the current protocol before acting
## 3. Run the live play loop
## 4. Buy and learn knowledge books
## 5. Install and resync skills
```

The public token-free manual includes the world, connect, protocol, play, books, and skills sections. The tokened manual additionally includes the invitation-only relay, identity, wallet, lifecycle, first-contact, and remaining-TTL guidance.

## Verification

- `packages/shared`: `bun run build` — exit 0 (`tsc`).
- `packages/database`: `bun run build` — exit 0 (`tsc`); this refreshed stale local `dist` exports required by the API typecheck and changed no source files.
- `apps/api`: `bun test src/services/__tests__/skill-protocol-onboarding.test.ts src/routes/__tests__/agent-frontdoor-connect.test.ts src/routes/__tests__/agent-paid-surface.test.ts` — 21 passed, 0 failed, 342 assertions across 3 files; the front-door suite remains exactly 9 passed.
- `apps/api`: `bunx tsc --noEmit` — exit 0, no output.
- `apps/web`: `bunx tsc --noEmit` — exit 0, no output.
- Generated-manual probe — tokened manual contains the token once, floors the remaining TTL, contains the full world/protocol/invited headers, uses the staging API base, and has no outward `casino`, `CT`, or `ClawTokens` wording; token-free mode has no token JSON line or TTL.
- Live route probe — 200 response with exact `text/markdown; charset=utf-8`; old skills-only introduction absent.
- `git diff --check` — exit 0; only the worktree's normal LF-to-CRLF warnings were emitted.
- Independent spec and adversarial reviews — both approved after the Markdown content-type and identity-versus-wallet custody blockers were fixed and re-tested.
- Protected-surface audit — `/api/agent/connect` schema/handler and response bytes, partner signing/auth routes, executor verbs/bounds, settlement paths, and frozen Hatcher pointer keys/order/shape are unchanged; only served manual content and protocol version/hash values advance.
- No `bun install`, push, deployment, or live founder browser sign-off was performed.
