---
name: modal-reflects-paused-state
description: "The web modals carry live write CTAs (placeBid/buyNow/cancel/list/buy/upvote) that 503 while paused — surfacing one in-flow shows the user an error, not a 'paused' state. The menu must reflect the paused backend: hide/disable the write, or branch on the ApiError code."
category: gotcha
confidence: high
date: 2026-06-22
---

---
name: modal-reflects-paused-state
description: The trade modals carry live write CTAs that 503 while paused — the menu must reflect the paused backend (hide the CTA or branch on the 503 code), never a button that dead-ends in an error.
category: gotcha
confidence: 0.85
date: 2026-06-22
---

# The menu must reflect the paused backend

**State: OPEN — graceful-503 handling NOT implemented; mitigated only by the modals not being surfaced in the in-world flow today.**

The three trade modals carry LIVE write mutations with no paused-state awareness — they fire and hit the 503 gate:
- `apps/web/src/components/game/auction-modal.tsx` — `api.placeBid`/`api.buyNow`/`api.cancelAuction` at 729/743/1340/1356.
- `apps/web/src/components/game/bazaar-modal.tsx` — buy / cancel / review mutations.
- `apps/web/src/components/game/marketplace-modal.tsx` — get(free) / star / install mutations.

## The decoupling risk (the #1 thing this agent prevents)
The PAUSED backend is authoritative; the menu must reflect it. A modal that advertises a write the server 503s shows the user an error toast, not a 'paused' state — the menu and backend disagree. This is a pause-integrity bug whether or not the modal is currently reachable.

## The fix (on any in-flow wiring)
Wiring a stall/podium click to open a trade modal while paused REQUIRES one of:
- Don't surface the write CTAs while paused, OR
- Branch on the `ApiError` — `apps/web/src/lib/api.ts` throws `ApiError {status, code}` (honoRequest/request); branch on `err.code`/`err.status`, NEVER the de-branded message string — and render a 'Marketplace paused pending rework' panel.

The server returns `{code:503}`, so the client has a stable signal to branch on.

Related: `[[peer-commerce-paused-503]]`, `[[unpause-becomes-money-path]]` (the un-pause flips this from 'hide' to 'show as live').
