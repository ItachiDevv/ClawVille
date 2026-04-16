# Phase 4a — One-click install to the user's local Milady

**Status:** PLANNING — not implemented.
**Date:** 2026-04-16
**Depends on:** Phase 3 complete and merged. Needs
`POST /api/agent/export-character` returning the full install bundle.
**Blocks:** Phase 4b gating decision — the demand signal captured in this
phase's waitlist determines whether 4b is ever built. See `AgentHosting.md`
§7 for the gating criteria.

---

## 1. Goal

Give the ClawVille user a **one-click way to install their agent into their
own Milady**, without touching our infrastructure. The button appears in two
places:

1. On the create-agent success screen (right after the pet is created, step
   2 complete).
2. Inside the renamed `AgentConnectModal` as a new tab/section labelled
   **"Deploy"**, next to the existing **"Quick Connect"** and **"Manual"**
   tabs.

The core flow is: user clicks → client fetches the bundle from Phase 3 →
client **POSTs from the user's own browser** to their local Milady at
`http://localhost:4000/api/plugins/install`. Our server never talks to
Milady on their behalf. If the local Milady is unreachable (common — not
every user runs it locally), we fall back to a download + curl instructions.

Side goal: capture the **"I don't run Milady locally, please host it for
me"** signal — a simple email waitlist that feeds the Phase 4b go/no-go
decision.

---

## 2. Non-goals

- No server-side Milady calls. Zero outbound. The browser is the client.
- No hosted runtime. Phase 4b, deferred.
- No Milady authentication flow. Local Milady accepts localhost calls
  without auth. Remote Milady is out of scope for Phase 4a.
- No marketplace integration. The export is a take-home copy, not a sale.
  Marketplace comes in Priority #3 work.

---

## 3. UI surfaces

### 3.1 Create-agent success screen

After step 2 (`/create-agent/personality`) completes the `POST /api/pets`,
we currently navigate to `/game`. Insert an intermediate screen
`/create-agent/deploy` that shows:

- Agent name, model thumbnail (reused from step 2's sessionStorage).
- **[Deploy to Milady] primary button** — kicks off the install flow below.
- **[Skip for now] secondary button** — jumps straight to `/game`, same
  as today's flow.

The screen is skippable. Users who don't care about taking the agent home
are not forced through it.

### 3.2 Agent-connect-modal "Deploy" tab

Add a third tab (after `Quick Connect` and `Manual`) called **`Deploy`**.
Its content is the same install flow as §3.1 but compact, for users who
already have a pet and want to export later.

---

## 4. Flow

```
[Deploy to Milady]
  ├─ Fetch POST /api/agent/export-character { petId }
  │    → receives { character, skillPack, miladyInstallPayload, installCommand }
  │
  ├─ Probe local Milady: fetch('http://localhost:4000/api/plugins/installed', { mode: 'cors' })
  │    ├─ 200 OK → "Milady detected" — show [Install now] button
  │    └─ error   → "Milady not detected" — show manual fallback UI
  │
  ├─ User clicks [Install now]
  │    → fetch('http://localhost:4000/api/plugins/install', POST, body: miladyInstallPayload)
  │       ├─ 200 → "Installed! Open Milady to chat with Shelly."
  │       └─ 4xx/5xx → show error + manual fallback UI
  │
  └─ Manual fallback UI:
       ├─ Download JSON button → Blob download of miladyInstallPayload
       ├─ Copy install command → clipboard writes installCommand
       ├─ Copy character JSON → clipboard writes character alone
       └─ "Don't run Milady locally?" → email waitlist capture
```

### 4.1 The CORS detail

`http://localhost:4000` from `https://clawville.world` is a cross-origin
call. The user's local Milady must allow it. The `@clawville/app-clawville`
plugin should already be configured to accept requests from our origin —
verify before shipping. If not, add a **per-release note to the plugin's
CORS config** and document it as a prerequisite.

If Milady does not allow the call, the fetch fails at the browser level
before hitting Milady. In that case we fall through to the manual UI.

### 4.2 Security note

The Phase 3 endpoint emits the full character + skills. The user is
authenticated. The install flow is entirely browser-to-browser (from the
user's session to the user's localhost). We are not acting as a proxy for
any third-party. No token sits on our server for this to work.

---

## 5. Waitlist capture

A small email input at the bottom of the manual fallback UI:

> **Don't run Milady locally?** Want us to host your agent for you?
> [email@example.com]  [Notify me]

POSTs to a new `/api/agent/waitlist` endpoint that writes to a new
`agent_hosting_waitlist` table:

```sql
CREATE TABLE agent_hosting_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  pet_id uuid REFERENCES pets(id),
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);
```

No spam protection beyond the UNIQUE constraint and an existing rate
limiter. The waitlist is a **signal** — we look at it when deciding whether
to build Phase 4b.

Stores the pet and user context so we know how many real pet-having users
asked for hosted. Anonymous email signups (no session) are accepted too —
`user_id` is nullable.

A simple script at `scripts/waitlist-report.ts` prints the count and
unique email total. Manually run it monthly.

---

## 6. UX polish

- Show progress spinner while fetching export bundle.
- Show the detected Milady version in the "Milady detected" state if the
  probe response includes it.
- Always show the `installCommand` as copy-able text below the primary
  button, so power users never feel trapped in the click flow.
- On install success, show the chat action the Milady plugin registered
  (`LAUNCH_CLAWVILLE`) as a tip: "Say 'open clawville' in any Milady chat
  to launch."
- Error state text must be specific. "Install failed (network error)" is
  useless; "Milady rejected the install at step 2 — see console for
  details" is actionable.

---

## 7. Acceptance criteria

- A new `/create-agent/deploy` page renders after pet creation and links to
  the install flow.
- The `Deploy` tab appears in `AgentConnectModal` and shows the same flow.
- Clicking [Deploy to Milady] with local Milady running installs the
  character successfully (verified manually).
- Clicking [Deploy to Milady] without local Milady shows the manual UI
  within 3s (probe timeout).
- Download JSON button produces a valid JSON file that parses.
- Copy install command writes a working one-liner to the clipboard.
- The waitlist email form writes a row to `agent_hosting_waitlist` and
  shows a success toast.
- Re-submitting the same email idempotently succeeds (UNIQUE constraint
  upserts, or the API returns "already subscribed" silently).
- No TypeScript errors on `bun run build`.

---

## 8. Testing plan

1. **Happy path with local Milady.** Run a local Milady (if dev machine
   supports it — otherwise ask the user to test). Create a pet, click
   deploy, verify the character appears in Milady's agent list.
2. **No local Milady.** Hit the deploy flow without Milady running.
   Confirm fallback UI appears within 3s. Download JSON, open in editor,
   verify shape.
3. **Waitlist.** Submit an email. Query the table. Submit same email — no
   duplicate.
4. **CORS.** Check browser DevTools Network tab for the Milady probe. If
   CORS fails, that's either a plugin config issue or a dev-tools
   reporting thing. Confirm the probe genuinely reached Milady if it
   claims success.

---

## 9. Audit plan

First + second pass per `CLAUDE.md` §Audit Guidelines. Focus areas:

- The Milady probe has a sensible timeout (≤ 3s) so users don't wait
  forever.
- No hardcoded `localhost:4000` — make the port configurable via an input
  field in the modal (some users run Milady on a different port).
- Waitlist API handles UNIQUE violation gracefully — no 500 on duplicate.
- The `installCommand` string is properly shell-escaped for single
  quotes / special characters in pet names (e.g. a pet named `O'Malley`
  must produce a valid curl command).
- Pet name with unicode (emoji, non-ASCII) survives the round-trip into
  the character JSON.
- The `character` JSON downloads with a meaningful filename
  (`<petName>-character.json`).
- On install-flow error, the retry path is obvious. A user should not have
  to refresh the page to retry.

---

## 10. Docs to update at merge time

- `CLAUDE.md` §Agent Connection — add the Deploy tab to the description.
- `ARCHITECTURE.md` — new client-to-local-Milady flow in the route /
  component diagram.
- `README.md` — if the user-facing quickstart mentions creating an agent,
  add a line about the Milady deploy option.
- `AgentHosting.md` §7 — note the waitlist is now live as the Phase 4b
  gating signal.
