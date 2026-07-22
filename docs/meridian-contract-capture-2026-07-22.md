# Meridian Contract Capture — SPEC 2 Phase A (read-only recon)

- **Date:** 2026-07-22
- **Scope:** READ-ONLY. Public docs + public API GET probes only. No devnet transaction, no repo code changes. The devnet smoke (spec §3) is deferred and scoped in §3 below.
- **Spec:** `docs/x402-partner-alignment-specs-2026-07-22.md` → SPEC 2 → Phase A.
- **API base:** `https://api.mrdn.finance`  ·  **Docs base:** `https://docs.mrdn.finance`
- **Probe host note:** Windows Git Bash curl requires `--ssl-no-revoke` (schannel CRL rejection).

Every claim below is backed by a verbatim quote + source URL. Anything not directly
confirmed from source is labeled **UNVERIFIED** in §4.

---

## §1 — Endpoint fixtures (verbatim)

### 1.1 `GET /v1/supported` — Get Supported Payment Kinds  (PUBLIC, no auth)

**Live probe** `https://api.mrdn.finance/v1/supported` → `HTTP/1.1 200 OK`, `Content-Type: application/json`, `Content-Length: 2248`. Verbatim body (2026-07-22 08:43 UTC):

```json
{"kinds":[{"x402Version":1,"scheme":"exact","network":"base-sepolia"},{"x402Version":1,"scheme":"upto","network":"base-sepolia"},{"x402Version":1,"scheme":"exact","network":"optimism-sepolia"},{"x402Version":1,"scheme":"upto","network":"optimism-sepolia"},{"x402Version":1,"scheme":"exact","network":"fluent-testnet"},{"x402Version":1,"scheme":"upto","network":"fluent-testnet"},{"x402Version":1,"scheme":"exact","network":"avalanche"},{"x402Version":1,"scheme":"upto","network":"avalanche"},{"x402Version":1,"scheme":"exact","network":"base"},{"x402Version":1,"scheme":"upto","network":"base"},{"x402Version":1,"scheme":"exact","network":"optimism"},{"x402Version":1,"scheme":"upto","network":"optimism"},{"x402Version":1,"scheme":"exact","network":"arbitrum"},{"x402Version":1,"scheme":"upto","network":"arbitrum"},{"x402Version":1,"scheme":"exact","network":"polygon"},{"x402Version":1,"scheme":"upto","network":"polygon"},{"x402Version":1,"scheme":"exact","network":"unichain"},{"x402Version":1,"scheme":"upto","network":"unichain"},{"x402Version":1,"scheme":"exact","network":"ink"},{"x402Version":1,"scheme":"upto","network":"ink"},{"x402Version":1,"scheme":"exact","network":"sei"},{"x402Version":1,"scheme":"upto","network":"sei"},{"x402Version":1,"scheme":"exact","network":"hyperevm"},{"x402Version":1,"scheme":"upto","network":"hyperevm"},{"x402Version":1,"scheme":"exact","network":"megaeth"},{"x402Version":1,"scheme":"upto","network":"megaeth"},{"x402Version":1,"scheme":"exact","network":"tempo"},{"x402Version":1,"scheme":"upto","network":"tempo"},{"x402Version":1,"scheme":"exact","network":"robinhood"},{"x402Version":1,"scheme":"upto","network":"robinhood"},{"x402Version":1,"scheme":"exact","network":"bsc"},{"x402Version":1,"scheme":"upto","network":"bsc"},{"x402Version":1,"scheme":"exact","network":"bot-chain"},{"x402Version":1,"scheme":"upto","network":"bot-chain"},{"x402Version":1,"scheme":"exact","network":"monad"},{"x402Version":1,"scheme":"upto","network":"monad"},{"x402Version":1,"scheme":"exact","network":"solana-devnet","extra":{"feePayer":"DhFm5NhZN5wXGyCAAS64Ae3Tdj8z8YkZGztDFfCpvt7b"}},{"x402Version":1,"scheme":"exact","network":"solana","extra":{"feePayer":"8g2JzjAS6yANmYHi51WCBWF4jdXVPw3Tn9GykYw2JGMy"}}]}
```

Load-bearing facts:
- `x402Version` is **1** for every kind (EVM and Solana).
- EVM chains advertise **both** `exact` and `upto` schemes. **Solana advertises `exact` ONLY** (no `upto`).
- Solana kinds carry `extra.feePayer` = Meridian's co-signing fee-payer pubkey:
  - `solana-devnet` → `DhFm5NhZN5wXGyCAAS64Ae3Tdj8z8YkZGztDFfCpvt7b`
  - `solana` (mainnet) → `8g2JzjAS6yANmYHi51WCBWF4jdXVPw3Tn9GykYw2JGMy`

### 1.2 `GET /v1/solana/facilitator?network={network}` — Solana facilitator info  (PUBLIC, no auth)

**Live probe (devnet)** `https://api.mrdn.finance/v1/solana/facilitator?network=solana-devnet` → `200 OK`. Verbatim:

```json
{"network":"solana-devnet","facilitator":"DhFm5NhZN5wXGyCAAS64Ae3Tdj8z8YkZGztDFfCpvt7b","programId":"Ro6hz1smrm5zDh73849eDqKna9dE1EkPsWekAB5rBWm","configPda":"DwwoJ5qTsQAs97xwBBRcf7He5j2xWuTtch1HPfiqP5fY","usdcMint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","treasury":"2e5ykhhcXT1HiTX89uyhDPEwq3j3bjcKr4AmHxhuscxp","treasuryToken":"H67ehh1Uj7wv9LfZvdXpZqPDRJt7hR9TNHTZKtLdR57L","treasuryFeeBps":100,"paused":false}
```

**Live probe (mainnet)** `https://api.mrdn.finance/v1/solana/facilitator?network=solana` → `200 OK`. Verbatim:

```json
{"network":"solana","facilitator":"8g2JzjAS6yANmYHi51WCBWF4jdXVPw3Tn9GykYw2JGMy","programId":"Ro6hz1smrm5zDh73849eDqKna9dE1EkPsWekAB5rBWm","configPda":"DwwoJ5qTsQAs97xwBBRcf7He5j2xWuTtch1HPfiqP5fY","usdcMint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","treasury":"2e5ykhhcXT1HiTX89uyhDPEwq3j3bjcKr4AmHxhuscxp","treasuryToken":"3FBo4R8Pa1PjJ9erUUwC1LuPrtCLKRMTrJ2ipHajkADq","treasuryFeeBps":100,"paused":false}
```

Documented schema (source: `https://docs.mrdn.finance/llms-full.txt`, "Solana Payments → Facilitator Info Endpoint"):

```typescript
export interface SolanaFacilitatorInfo {
  network: string;
  facilitator: string;
  programId: string;
  configPda: string;
  usdcMint?: string;
  treasury?: string;
  treasuryToken?: string;
  treasuryFeeBps?: number;
  paused?: boolean;
}
```

Load-bearing facts (LIVE, both clusters):
- `programId` = `Ro6hz1smrm5zDh73849eDqKna9dE1EkPsWekAB5rBWm` (matches spec ground-truth; identical mainnet + devnet).
- `treasuryFeeBps` = **100 (1.00%)** on BOTH mainnet and devnet.
- `paused` = **false** (facilitator live) on both.
- `usdcMint` matches x402 canonical: mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

### 1.3 `GET /v1/batched-sample` — Get Gateway Status  (REQUIRES API KEY — evidence for 2b)

**Live probe** `https://api.mrdn.finance/v1/batched-sample` (no key) → `HTTP/1.1 401 Unauthorized`. Verbatim body:

```json
{"error":"No organization found for this request"}
```

Documented shape when authed (source `https://docs.mrdn.finance/llms-full.txt`, "Get Gateway Status"):

```json
{
  "success": true,
  "data": {
    "message": "Circle Gateway batched nanopayments integration",
    "organization": "Acme",
    "organizationId": "org_123",
    "gatewayMainnetEnabled": true,
    "networkStatus": { "base": true, "optimism": true },
    "gatewaySupported": {},
    "endpoints": { "batchedVerify": "POST /v1/batched-verify", "batchedSettle": "POST /v1/batched-settle" }
  }
}
```

Note: Gateway Status is a **Circle-Gateway (EVM-batching) diagnostic**, org-scoped, and is orthogonal to the Solana same-chain settle path. It is NOT required for Solana facilitator redundancy (Phase B).

### 1.4 `POST /v1/settle` — Settle x402 Payment

**Live probe** `GET https://api.mrdn.finance/v1/settle` (self-describing GET on the POST route, no auth) → `200 OK`. Verbatim:

```json
{"endpoint":"POST /v1/settle","description":"Settle x402 payments with organization-specific authentication","authentication":"Requires valid API key with organization context","body":{"paymentPayload":"PaymentPayload object conforming to x402 schema","paymentRequirements":"PaymentRequirements object conforming to x402 schema"},"response":{"success":"boolean indicating if settlement was successful","transaction":"transaction hash if successful","errorReason":"string explaining why settlement failed (if applicable)","network":"network where settlement occurred","authContext":"information about the authentication method used"},"features":["Organization-specific x402 authentication","Authentication context in responses","Comprehensive error handling"]}
```

Documented request headers (source `https://docs.mrdn.finance/api-reference`):
```
Authorization: Bearer {MERIDIAN_API_KEY}
Content-Type: application/json
```

**Solana request payload** (source `https://docs.mrdn.finance/llms-full.txt`, "Solana Payload" + `payments/solana-program.md`):

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "solana-devnet",
  "payload": {
    "transaction": "<base64 of the payer-signed settlement transaction>"
  }
}
```

**Solana `paymentRequirements`** (source `llms-full.txt`, "Solana Payment Requirements"):

```typescript
const paymentRequirements = {
  scheme: "exact",
  network,
  asset: config.usdcMint,
  payTo: process.env.SOLANA_RECIPIENT_WALLET,
  maxAmountRequired: amountInUsdcBaseUnits,
  resource: "https://seller.example/api/tool",
  description: "Paid access to agent action",
  mimeType: "application/json",
  maxTimeoutSeconds: 600,
  extra: {
    name: "USDC",
    decimals: 6,
    feePayer: facilitator,
    creditedRecipient: process.env.SOLANA_RECIPIENT_WALLET,
  },
};
```

**Success / error responses** (source `llms-full.txt`, "Settle x402 Payment"):

```json
{ "success": true, "transaction": "0x1234567890abcdef...", "network": "base-sepolia" }
```
```json
{ "success": false, "errorReason": "insufficient_funds", "transaction": "", "network": "base-sepolia" }
```
Documented error codes: `invalid_payload`, `invalid_payment_requirements`, `insufficient_funds`, `unexpected_settle_error`, `invalid_transaction_state`. (The 402-family module contract we mirror in `x402-payai.ts` — never-throw, settle-gated-on-verify, non-empty-signature — maps onto `success`/`errorReason`/`transaction`.)

### 1.5 Solana on-chain instruction reference  (source `payments/solana-program.md` + `llms-full.txt`)

`transfer_with_authorization` instruction — **66-byte data**:
```
discriminator     8 bytes   [241, 208, 6, 43, 81, 61, 213, 10]
value             u64 LE    amount in USDC base units
valid_after       i64 LE    unix seconds (0 = immediately valid)
valid_before      i64 LE    unix seconds (now + maxTimeoutSeconds)
nonce             32 bytes  random
platform_fee_bps  u16 LE    0 unless in platform mode
```

**Account order (always 9):** `payer` (signer, writable), `from` (signer), `config`, `usdc_mint`, `from_token` (writable), `recipient_token` (writable), `platform_token` (writable — or the program ID as a read-only placeholder when there is no platform fee), `treasury_token` (writable), `token_program`.

**Fee math** (source `solana-program.md`, "identical to EVM"):
```
platform_fee = value × platform_fee_bps / 10_000
remainder    = value − platform_fee
treasury_fee = remainder × treasury_fee_bps / 10_000
net_amount   = remainder − treasury_fee        (→ recipient)
MAX_FEE_BPS  = 1000 (10% ceiling on each fee)
```
Settlement executes "up to three `transfer_checked` CPIs" (platform, treasury, recipient-net). Quote: "The settlement transaction does **not** create any token accounts" — payer ATA, recipient ATA, platform/treasury token accounts must all pre-exist.

### 1.6 Source URLs used
- `https://docs.mrdn.finance/llms.txt` (doc map)
- `https://docs.mrdn.finance/llms-full.txt` (verbatim bulk — primary text source; per-page `.md` slugs mostly 404 under guessed paths)
- `https://docs.mrdn.finance/api-reference` (settle headers/body)
- `https://docs.mrdn.finance/payments/solana-program.md` (Solana program, fees, instruction)
- `https://docs.mrdn.finance/api-reference/supported-networks.md` (network list + cross-chain scope)
- Live GET probes: `/v1/supported`, `/v1/solana/facilitator?network=solana-devnet`, `?network=solana`, `/v1/batched-sample`, `GET /v1/settle`

---

## §2 — Spec answers with evidence

### 2a — Does Meridian's Solana facilitator accept a standard `@x402/svm` exact payload (same wire as PayAI), or a Meridian-specific variant?

**Verdict: SHARED x402 ENVELOPE, but a MERIDIAN-SPECIFIC Solana transaction. NOT drop-in wire-compatible with our PayAI `ExactSvmScheme` path. Phase B needs a Meridian-specific Solana transaction builder.** (High confidence from docs + live probe + structural fee argument; the plain-transfer-rejection edge is UNVERIFIED until the devnet smoke — see §4.)

What matches (the outer x402 envelope):
- `scheme: "exact"` and a base64 `payload.transaction` field — the same *shape* the x402 SVM exact scheme uses.

What DIVERGES from our current PayAI path (`custodial-x402.ts` on `origin/master`, verbatim):
```typescript
// our standard builder:
const client = new x402Client();
client.register(caip2, new ExactSvmScheme(signer, { rpcUrl: input.rpcUrl }));
const payload = await client.createPaymentPayload({ x402Version: 2, resource, accepts: [requirements] });
// requirements.network = caip2ForNetwork(network)  → CAIP-2 string
```
1. **x402Version:** Meridian advertises and expects **`1`** (`/v1/supported` + Solana payload docs). Our PayAI builder emits **`2`**. Mismatch.
2. **Network encoding:** Meridian uses plain strings **`"solana"` / `"solana-devnet"`**. Our builder uses **CAIP-2** (`caip2ForNetwork(...)`). Mismatch.
3. **The load-bearing one — the signed transaction itself.** Meridian's settlement transaction must invoke **their own on-chain program** `Ro6hz1smrm5zDh73849eDqKna9dE1EkPsWekAB5rBWm` via the custom `transfer_with_authorization` instruction (discriminator `[241,208,6,43,81,61,213,10]`, 66-byte data, fixed 9-account layout, `config`/`treasury_token`/`platform_token` accounts), which performs the 3-way `transfer_checked` fee split. The stock `@x402/svm` `ExactSvmScheme` builds a **plain SPL `transferChecked` payer→payTo** with the facilitator as fee payer — a *different* transaction with no Meridian program, no config PDA, no treasury account.
   - **Structural proof this cannot be a plain transfer:** Meridian charges a nonzero **on-chain treasury fee (1%, live)**. An on-chain fee split is only expressible through a program that emits the extra `transfer_checked` CPI. A plain SPL transfer physically cannot carry Meridian's treasury cut, so Meridian's Solana path *must* be its own program instruction. (PayAI's exact-SVM is a plain transfer, which is why PayAI takes no on-chain treasury fee.)

Evidence quotes:
- `/v1/supported` Solana entry (live): `{"x402Version":1,"scheme":"exact","network":"solana-devnet","extra":{"feePayer":"DhFm5N..."}}`.
- Docs (`llms-full.txt`): "The client builds a transaction with `transfer_with_authorization` parameters … The payer signs this transaction; the facilitator validates and co-signs before submission." + the 9-account layout + custom discriminator.
- Docs: Solana "uses the same `POST /v1/settle` endpoint with a distinct flow. The buyer signs the full settlement transaction (no EIP-712 typing or Permit2)."

Phase B implication: `x402-meridian.ts` cannot reuse `prepareCustodialExactPayment` as-is for the Solana path. It must (a) emit `x402Version:1` + plain network string, and (b) assemble Meridian's `transfer_with_authorization` instruction from `/v1/solana/facilitator` (`programId`, `configPda`, `treasury`/`treasuryToken`, `feePayer`, `usdcMint`) + derived ATAs, have the payer sign, base64 → `payload.transaction`. The `verifyAndSettle`-shaped *contract* (never-throw, settle-gated-on-verify, non-empty-sig) still holds; only the payload construction is Meridian-specific.

### 2b — API-key onboarding (self-serve vs gated); where OUR platform-fee bps is set; Meridian treasury cost/tx; vs PayAI.

**Onboarding: SELF-SERVE, no sales call.** (source `llms-full.txt`, "API Keys Onboarding")
1. Connect wallet at `https://mrdn.finance` (SIWE session).
2. For Solana, configure the organization's Solana recipient wallet.
3. Open `https://mrdn.finance/dev/api-keys`, create an organization-scoped API key (public `pk_...`, stored on backend).
4. Programmatic: `POST https://api.mrdn.finance/v1/api_keys` with `Cookie: siwe-session=...`, body `{ "name": "...", "test_net": true }`.

Doc quote: seller setup "requiring no external approval step or sales interaction." The live `401 {"error":"No organization found for this request"}` on `/v1/batched-sample` confirms authed endpoints are org-key-gated, but the key itself is minted self-serve by connecting a wallet. Note: org creation is gated behind a **SIWE (EVM-wallet) sign-in**, even for a Solana-only integration.

**Where OUR platform-fee bps is set: PER-PAYMENT, not org-level.** (source `llms-full.txt`)
- We (the resource server) advertise it in `paymentRequirements.extra.platformFeeBps` (doc: `"platformFeeBps?: number;"` = "platform fee in basis points"). On Solana it becomes the `platform_fee_bps` u16 in the instruction data; when zero, the `platform_token` account slot is filled with the program ID as a read-only placeholder.
- Ceiling: `MAX_FEE_BPS = 1000` (10%). This maps to our Phase-B `MERIDIAN_PLATFORM_FEE_BPS` env (default 0). The platform fee is OUR cut (routed to our `platform_token`); it is additive on the payer and does not reduce Meridian's treasury fee.

**Meridian treasury cost per tx: `treasuryFeeBps = 100` (1.00%), verified LIVE on mainnet + devnet.** It is deducted from `remainder` (= value − our platform fee), so it reduces recipient-net. Gas: Meridian co-signs as fee payer and submits (docs), i.e. it sponsors the SOL network fee like PayAI sponsors gas.

**Fee comparison vs PayAI (spec mandate — treasury bps vs PayAI's $0.001 flat at ~$0.03 median):**
- Meridian treasury on a $0.03 tx = `$0.03 × 100/10_000 = $0.0003`.
- PayAI = `$0.001` flat.
- **At the $0.03 median, Meridian ($0.0003) is CHEAPER than PayAI ($0.001).** Break-even is at `tx = $0.001 / 0.01 = $0.10`: below $0.10 Meridian's 1% is cheaper; above $0.10 PayAI's flat is cheaper.
- **Spec guard result:** "never route outbound through Meridian while its treasury bps exceeds PayAI's $0.001-flat equivalent at $0.03" → the guard is **SATISFIED** at the median (Meridian is under). Caveat: it inverts for txs > ~$0.10, so the guard must be enforced dynamically by tx size, not assumed once. (Independently, per spec, outbound micropayments STAY on PayAI regardless; Meridian is inbound-only.)

### 2c — Can an EVM payer settle to a SOLANA recipient (Across / Circle Gateway routing)?

**Verdict: NO. Cross-chain is EVM→EVM only. Solana is same-chain only. An EVM payer CANNOT be credited to a Solana recipient.** This decides Phase C toward the EVM-treasury decision-memo path (do NOT build by default).

Evidence (source `api-reference/supported-networks.md` + `llms-full.txt`):
- "It is **same-chain only** — there is no Across cross-chain routing on Solana in this version."
- "Payments are same-chain only (no Across cross-chain routing on Solana in this version)."
- Cross-chain is Across-backed and EVM-only: "For USDC routes supported by Across, this same EIP-3009 path can settle cross-chain." `destinationChainId` / `creditedRecipient` are **EVM chain IDs / EVM addresses only** (the doc's cross-chain example uses `destinationChainId: 8453` = Base, `network: "ink"` — EVM→EVM).
- Solana recipient requirement: set "`paymentRequirements.payTo` to the seller's recipient wallet (owner, not a token account), matching the org's configured Solana recipient."
- No Circle-Gateway/CCTP EVM→Solana routing is documented anywhere ("no information about Circle Gateway supporting cross-chain routing … No Solana integration is referenced for Circle Gateway").

Phase C consequence (per spec §Phase C): EVM inbound would require an **EVM recipient address we own** (a new Base/EVM custody surface — Meridian's EVM receiver-proxy holds balances until withdrawal, conflicting with "no third-party balance custody" unless auto-swept). → Write the one-page decision memo, take to founder, **do not build by default**. Phase B (Solana facilitator redundancy, same-chain) proceeds independently and needs no EVM surface.

---

## §3 — Remaining Phase A step: devnet smoke (deferred; write-scope, out of this read-only pass)

Spec §3 requires: "one $-cents settle on `solana-devnet` against their facilitator from a staging test wallet. On-chain sig or it didn't happen." This is a mutation (on-chain devnet tx) and is intentionally NOT done in this read-only pass. To execute it, we need:

1. **Meridian org + API key (self-serve):** connect an EVM wallet at `mrdn.finance` (SIWE), configure the org's **Solana recipient wallet**, mint a `test_net` `pk_...` key at `/dev/api-keys`.
2. **Payer wallet (staging test):** a Solana **devnet** keypair holding **devnet USDC** (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) with an existing USDC ATA. Payer needs **no SOL** (Meridian's fee payer `DhFm5NhZN5wXGyCAAS64Ae3Tdj8z8YkZGztDFfCpvt7b` sponsors gas), but ATAs must pre-exist (program creates none).
3. **Recipient (payTo):** a devnet wallet owner (not ATA) matching the org's configured Solana recipient, with a USDC ATA pre-created.
4. **Meridian-specific tx builder** (see 2a): assemble `transfer_with_authorization` from `/v1/solana/facilitator?network=solana-devnet` (`programId Ro6hz1…`, `configPda DwwoJ5…`, `treasuryToken H67ehh…`, `feePayer DhFm5N…`, `platform_fee_bps=0`), payer signs, base64 → `payload.transaction`.
5. **Settle:** `POST https://api.mrdn.finance/v1/settle` with `Authorization: Bearer pk_...`, body `{ paymentPayload, paymentRequirements }`; assert `success:true` + non-empty `transaction`, then confirm the sig on a devnet explorer.

This smoke doubles as the empirical answer to the one 2a caveat (whether the facilitator would also accept a plain-transfer exact payload — expected NO given the fee-split program requirement).

---

## §4 — UNVERIFIED / open items (label per "burned by unverified partner claims" rule)

- **UNVERIFIED — devnet settle not executed.** No on-chain sig captured this pass (read-only scope). The end-to-end Solana settle, the exact-wire acceptance test, and the treasury-fee deduction in practice remain to be proven by §3's smoke.
- **UNVERIFIED (structural-confidence only) — that stock `@x402/svm` `ExactSvmScheme` output is rejected by Meridian.** The conclusion rests on docs (custom program instruction) + the structural fee-split argument, not a live 400/settle attempt. Confirm in the smoke.
- **UNVERIFIED — API rate limits / SLA.** No rate-limit or SLA numbers are documented for `/v1/settle`, `/v1/supported`, or `/v1/solana/facilitator`. Needed before Phase B relies on Meridian as a failover.
- **UNVERIFIED — exact `/v1/api_keys` response shape + whether `pk_`/`sk_` split exists.** Onboarding steps are documented; the key-creation JSON response and any secret-key half were not probed (would require a SIWE session — mutation).
- **UNVERIFIED — "Get Gateway Status" authed body** (§1.3 doc JSON) and per-page doc slugs. Most `.md` page slugs 404'd under guessed paths; the verbatim text came from `llms-full.txt`. The authed `/v1/batched-sample` body was not retrieved (no key); only the 401 is live-confirmed.
- **UNVERIFIED — quote bounds for Solana.** The `upto`/variable-amount + `settleAmount` bounds (`0 < settleAmount ≤ permit.permitted.amount`) are **Permit2 = EVM-only**; Solana is `exact`-only, so there are no Solana quote bounds. No standalone "quote bounds" endpoint was found (`maxAmountRequired` / `maxTimeoutSeconds` in requirements are the only bounds on the Solana exact path).
- **NOTE (not a gap) — no PROTOCOL_VERSION impact from Phase A** (read-only). Phase B facilitator-fallback (same wire) needs no bump per spec; only a change to agent-visible 402 `accepts[]` (Phase C) would.
