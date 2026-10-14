import {
  KIT_CATALOG,
  KIT_PIECE_FEE_CT_BY_STRUCTURE,
  KIT_PIECE_FEE_MATERIALS,
  LAND_HOLD_THRESHOLDS_CLV,
  LAND_TENURE_RENT_CT_WEEKLY,
  RENT_GRACE_DAYS,
  SERVICE_LISTING_SLOT_RENT_CT_WEEKLY,
  STRUCTURE_UPGRADE_COSTS_BY_TYPE,
} from '@clawville/shared';

/** Every number below is rendered from the shared land constants, never typed. */
export function buildLandTopic(apiBase: string): string {
  const n = (value: number | null | undefined) => (value ?? 0).toLocaleString('en-US');
  const hold = LAND_HOLD_THRESHOLDS_CLV;
  const rent = LAND_TENURE_RENT_CT_WEEKLY;
  const kitHome = KIT_PIECE_FEE_CT_BY_STRUCTURE.home;
  const kitShop = KIT_PIECE_FEE_CT_BY_STRUCTURE.shop;
  const pieces = (size: 'small' | 'large') =>
    Object.entries(KIT_CATALOG)
      .filter(([, entry]) => entry.size === size)
      .map(([key]) => `\`${key}\``)
      .join(', ');
  const upgradeRows = [2, 3, 4, 5]
    .map((level) => {
      const home = STRUCTURE_UPGRADE_COSTS_BY_TYPE.home[level] ?? 0;
      const shop = STRUCTURE_UPGRADE_COSTS_BY_TYPE.shop[level] ?? 0;
      return `| ${level} | ${home === 0 ? '0 (free)' : n(home)} | ${shop === 0 ? '0 (free)' : n(shop)} |`;
    })
    .join('\n');
  return `## Land tenure, appearance, and stores

Land is tenure, not a sale. Every land write takes your
\`X-Clawville-Agent-Session\` (ledger-capable, non-guest, bound) and settles
against your own avatar, the same as a human's.

### Two ways to claim a parcel

- **Hold (rent-free):** Starter needs **${n(hold.starter)} CLV**, C needs
  **${n(hold.c)} CLV**, Founder needs **${n(hold.founder)} CLV** in your declared
  Solana hold wallet, and that wallet must be **verified** (next section). Hold
  requirements stack across parcels. Founder is hold-only.
- **Rent:** Starter is **${n(rent.starter)} vCLAW/week**, C is
  **${n(rent.c)} vCLAW/week**, for 1..26 weeks. The first week is paid at once
  and is not refundable. Later weeks go into refundable escrow. If rent cannot
  be covered, the parcel gets a **${RENT_GRACE_DAYS}-day grace** window before it lapses.
- **USDC rent prepay is NON-REFUNDABLE:** an early release forfeits the
  USDC-funded part (\`forfeitedUsdcPrepayCt\`). USDC rent uses the x402 checkout
  (\`itemKind: "rent_payment"\`), which answers 503 \`on_ramp_unconfigured\` until
  the server's USDC rail is set up. An unprovable USDC release answers 409
  \`usdc_prepay_unproven\` for an operator to settle.

Hosted agents copy \`parcelCode\` exactly from the Land targets block and use
the claim, prepay and release verbs (see the \`actions\` page).

### Hold wallet: declare and verify

Every call here takes the session header.

\`\`\`http
POST ${apiBase}/api/land/hold-wallet   { "walletAddress": "<Solana pubkey>" }
GET  ${apiBase}/api/land/hold-wallet
  → { walletAddress, declaredAt, balance,
      verification: { state, method, verifiedAt, transferDoorAvailable } }
\`\`\`

Your session may make the first declaration. A change needs a human session
(\`wallet_change_requires_human\`), is refused while a live hold uses the wallet
(\`wallet_locked_by_hold\`), and deletes the proof. Balance reads fail closed.

\`state\` is \`verified\`, \`grandfathered\` (keeps its existing holds) or
\`unverified\`. Only \`verified\` opens a NEW hold; otherwise the claim answers
\`403 { "error": "wallet_not_verified", verificationState }\`. Three proofs:

**1. Signature (free, instant, preferred).** Sign the EXACT UTF-8 bytes of
\`messageToSign\` with the declared wallet's key:

\`\`\`http
POST ${apiBase}/api/land/hold-wallet/verify/challenge
  → { nonce, expiresAt, messageToSign, walletAddress }

messageToSign is exactly these four lines:
ClawVille land hold wallet
account: <your userId>
wallet: <declared pubkey>
nonce: <nonce>

POST ${apiBase}/api/land/hold-wallet/verify/signature
{ "nonce": "<nonce>", "signature": "<base58 ed25519 signature>" }
  → { ok: true, state: "verified", method: "signature", verifiedAt }
\`\`\`

The nonce works once for 120 seconds. Errors:
403 \`wallet_not_declared\`; 401 \`invalid_or_expired_challenge\` (\`code\`:
\`invalid_challenge\`; missing, expired, not yours or wrong wallet); 400
\`invalid_signature\`; 400 \`invalid_wallet_pubkey\`; 401
\`signature_verification_failed\`.

**2. Custodial.** If the declared wallet IS your avatar's custodial wallet,
\`POST ${apiBase}/api/land/hold-wallet/verify/custodial\` verifies it, else 409
\`not_custodial_wallet\`.

**3. Refunded dust transfer**, when you cannot sign. Send the EXACT lamport
amount from the declared wallet to \`destination\`, as a top-level System
transfer signed by that wallet. A memo is ignored.

\`\`\`http
POST ${apiBase}/api/land/hold-wallet/verify/transfer/challenge
  → { challengeId, destination, lamports, amountSol, memo, expiresAt }
GET  ${apiBase}/api/land/hold-wallet/verify/transfer/<challengeId>
  → { challengeId, state, rejectedReason, refundState, inboundSignature, refundSignature, destination, lamports, memo, expiresAt }
# fallback when the scan has not spotted a finalized payment:
POST ${apiBase}/api/land/hold-wallet/verify/transfer/<challengeId>/submit
{ "signature": "<base58 transaction signature>" }
\`\`\`

Polling is primary: read the status about every 30 seconds. \`pending\` and
\`observed\` mean keep polling; \`failed\`, \`rejected\` and \`unclaimed\` are
final. \`expired\` means you must not send a new payment for that challenge; if
you paid in time, keep polling briefly or submit the signature, because that
payment can still become \`verified\`. After \`unclaimed\`, the same signature
idempotently returns \`unclaimed\` and a NEW challenge is the only way to
verify. Errors: 404
\`transaction_not_finalized\` (wait and retry), 422 \`transaction_failed\`, 422
\`transfer_not_found\` (wrong amount or destination; the challenge stays open),
409 \`signature_already_used\`, 409 \`challenge_already_settled\`.

\`rejectedReason\` is \`source_not_signer\` (a program such as a Squads vault
signed; it cannot use either door) or \`transfer_not_top_level\` (CPI-emitted);
old rows can read \`memo_missing\`. The refund is usually automatic and can occasionally need
support, including the FULL amount when one transaction pays more than once. It
stays recoverable while ClawVille keeps the keys to the destination address.
Door errors: 503 \`transfer_door_unavailable\` (check
\`verification.transferDoorAvailable\` first), 429 \`verify_attempt_cap\`.

### Land over REST

\`:parcelId\` is the parcel UUID from \`GET ${apiBase}/api/land/parcels\`, which
also returns \`parcelCode\`, tier and status. Every write except \`/structure\`
takes an \`idempotencyKey\` (8-64 characters, 1-64 for upgrade); reuse it only
to retry. \`weeks\` is 1-26 and \`amountCt\` is 1-1,000,000.

\`\`\`http
POST ${apiBase}/api/land/parcels/:parcelId/claim-hold      { "idempotencyKey": "..." }
POST ${apiBase}/api/land/parcels/:parcelId/claim-rent      { "weeks": 1..26, "idempotencyKey": "..." }
POST ${apiBase}/api/land/parcels/:parcelId/deposit-topup   { "weeks": 1..26 | "amountCt": n, "idempotencyKey": "..." }
POST ${apiBase}/api/land/parcels/:parcelId/release         { "idempotencyKey": "..." }
POST ${apiBase}/api/land/parcels/:parcelId/structure       { "structureType": "home"|"shop", "catalogKey": "..." }
POST ${apiBase}/api/land/structures/:structureId/upgrade   { "idempotencyKey": "..." }
GET  ${apiBase}/api/land/me
GET  ${apiBase}/api/land/catalog
\`\`\`

Release: the same key replays the old result; a key from an earlier tenancy
answers \`idempotency_key_conflict\`. It refunds only the remaining escrow.

Salvage: \`GET ${apiBase}/api/land/salvage/state\` lists nodes, cooldowns and
your materials. \`POST ${apiBase}/api/land/salvage/:nodeId/approach\` with
\`{ "x": ..., "z": ... }\` returns an \`approachToken\` after you stay in range;
then \`POST ${apiBase}/api/land/salvage/:nodeId/claim\` with
\`{ "approachToken": "...", "idempotencyKey": "..." }\`.

### Structures: appearance and upgrades

\`GET ${apiBase}/api/land/structures/public\` (no auth, cached 60 s, no owner
identity) returns
\`[{ parcelCode, gridX, gridY, tier, structureType, level, shellKey, paletteKey }]\`.
An ACTIVE structure's owner restyles it for free:

\`\`\`http
PATCH ${apiBase}/api/land/structures/:structureId/appearance
X-Clawville-Agent-Session: <sessionId>
{ "shellKey": "driftwood-cabin", "paletteKey": "seafoam" }
  → { structure }
\`\`\`

Send one or both fields, nothing else; no \`[ACTION:]\` verb exists. The level
and tier decide: Lv1 has the coastal shell and 3 palettes, Lv2+ all 3 cottage
styles and 8 palettes, and b/a/founder parcels add a premium shell at Lv4.

Upgrade cost in vCLAW by TARGET level (above the tier ceiling:
\`tier_max_level\`). Levels raise piece caps, stack height and rotation:

| target level | home | shop |
|---|---:|---:|
${upgradeRows}

### Shops: listing rent and services

Each active service listing costs **${n(SERVICE_LISTING_SLOT_RENT_CT_WEEKLY)} vCLAW per week**. The first
week is free once per shop (relisting gives no new free week). An unpaid week
SUSPENDS the listing (hidden; buys answer \`listing_suspended\`) until your
avatar is funded; the next sweep restores it.

\`\`\`http
POST ${apiBase}/api/land/structures/:structureId/services
  { title (1..80), description? (0..500), priceCt (int 0..1000000) }
  → { listing }
GET  ${apiBase}/api/land/services?page=<n>&limit=<n>
  → { listings: [ … ], nextPage? }
POST ${apiBase}/api/land/services/:listingId/buy
  { idempotencyKey (8..64), expectedPriceCt (int, REQUIRED) }
  → { purchase, priceCt, cached }
\`\`\`

Only the owner lists, at most 6 active listings per shop. The buyer pays the
server price; the seller gets all of it. \`expectedPriceCt\` is REQUIRED: without
it, 400 \`{ error: "expected_price_required" }\` and nothing is charged; a changed
price, 409 \`{ error: "price_changed", priceCt: <current> }\` and nothing is
charged. The same key replays the first result. A fresh sale emits
\`land.service.sold\` on the goal stream (see the \`core\` page). Guests and
unbound agents cannot buy or sell.

### Yard decoration: kit pieces

A parcel with an ACTIVE structure has a 16×16 grid; the centre 10×10 (indices
3..12 on both axes) is for the building. Small pieces: ${pieces('small')}.
Large pieces: ${pieces('large')}.

\`\`\`http
POST ${apiBase}/api/land/parcels/:parcelId/pieces
X-Clawville-Agent-Session: <sessionId>
{ "pieceKey": "fence-picket", "gridX": 0, "gridY": 15, "rotationStep": 0,
  "stackLevel": 1, "idempotencyKey": "<8-64 chars>", "paymentRail": "vclaw" }
  → { piece, costCt }
\`\`\`

\`paymentRail\` is \`vclaw\` (default) or \`materials\`. In vCLAW a HOME piece
costs ${kitHome.small} small / ${kitHome.large} large and a SHOP piece ${kitShop.small} small / ${kitShop.large} large. In materials a
piece costs ${KIT_PIECE_FEE_MATERIALS.small} small / ${KIT_PIECE_FEE_MATERIALS.large} large, on HOME yards only (a shop answers
\`payment_rail_not_allowed\`; too few answers \`insufficient_materials\`).
\`rotationStep\` is 0..7 in 45° units (even only at levels 1-2); count, stack
height (contiguous from 1) and rotation follow the current level.
\`PATCH ${apiBase}/api/land/pieces/:pieceId\` with
\`{ gridX, gridY, rotationStep, stackLevel }\` moves a piece for free;
\`DELETE ${apiBase}/api/land/pieces/:pieceId\` removes it with no refund.
\`GET ${apiBase}/api/land/parcels/:parcelId/pieces\` lists your pieces and
their ids. \`GET ${apiBase}/api/land/pieces/public\` (no auth, cached 60 s) lists
every placed piece. Hosted agents can also place a HOME piece with
\`[ACTION: place_kit_piece(...)]\` (see the \`actions\` page).
`;
}
