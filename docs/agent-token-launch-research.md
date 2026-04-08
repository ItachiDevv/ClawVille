# Agent Token Launch — Full Research

> Compiled from 4 parallel research agents. Covers Pump.fun, Raydium LaunchLab, vanity CAs, wallet architecture, dev wallet patterns, creator fees, and SDK/API integration.

---

## Table of Contents

1. [Platform Comparison](#1-platform-comparison)
2. [Pump.fun Deep Dive](#2-pumpfun-deep-dive)
3. [Raydium LaunchLab Deep Dive](#3-raydium-launchlab-deep-dive)
4. [Vanity Contract Addresses](#4-vanity-contract-addresses)
5. [Wallet Architecture — The 3 Dev Wallet Modes](#5-wallet-architecture--the-3-dev-wallet-modes)
6. [Creator vs Signer — The Critical Discovery](#6-creator-vs-signer--the-critical-discovery)
7. [Transaction Co-Signing Flows](#7-transaction-co-signing-flows)
8. [Creator Fees](#8-creator-fees)
9. [PumpPortal API](#9-pumpportal-api)
10. [Raydium SDK Integration](#10-raydium-sdk-integration)
11. [ElizaOS Integration](#11-elizaos-integration)
12. [Existing Agent Launch Platforms](#12-existing-agent-launch-platforms)
13. [ClawVille Platform Registration](#13-clawville-platform-registration)
14. [Recommended Architecture](#14-recommended-architecture)
15. [Implementation Checklist](#15-implementation-checklist)
16. [Sources](#16-sources)

---

## 1. Platform Comparison

| Feature | Pump.fun | Raydium LaunchLab |
|---------|----------|-------------------|
| **Token creation cost** | Free | Free |
| **Graduation fee** | 0.015 SOL | 0 SOL |
| **Trading fee (bonding curve)** | 1.25% (0.3% creator + 0.95% protocol) | ~1% (0.25% protocol + 0.75% platform) |
| **Trading fee (post-grad)** | 0.3-1.25% (dynamic by market cap) | 1% (CPMM pool) |
| **Bonding curve types** | Single (exponential-like) | Linear, exponential, logarithmic |
| **Quote tokens** | SOL only | SOL, USDC, USDT, jitoSOL |
| **Graduation threshold** | ~85 SOL (~$90K market cap) | 30-85+ SOL (configurable) |
| **Post-grad creator fees** | 0.05-0.95% of trades (dynamic) | 10% of LP fees (via Fee Key NFT) |
| **Migration destination** | PumpSwap AMM | Raydium CPMM or AMM v4 |
| **Custom platforms** | No | Yes (third-party platform PDA) |
| **Vesting support** | No | Yes (cliff + duration) |
| **Supply customization** | Fixed | 51-80% on curve |
| **SDK/Programmatic** | PumpPortal API + @pump-fun/pump-sdk | Full TypeScript SDK (@raydium-io/raydium-sdk-v2) |
| **Market share** | ~60%+ of Solana launches | ~30-40% of Solana launches |
| **Graduation rate** | ~1.15% | ~0.21% |
| **Creator field requires signature?** | No | No |
| **Vanity mint keypair supported?** | Yes (mint is isSigner: true) | Yes (via extraSigners) |

---

## 2. Pump.fun Deep Dive

### Program IDs (2025-2026)

| Program | ID | Purpose |
|---------|------|---------|
| **Pump** (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | Token creation + bonding curve trading |
| **PumpSwap AMM** | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | Post-graduation AMM pools |
| **PumpFees** | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | Fee sharing/config |
| **Mayhem** | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` | Mayhem mode fee routing |

### Token Lifecycle

1. **Creation** via `create_v2` (Token2022) on Pump program
2. **Bonding curve trading** — buy/sell with fee routing
3. **Graduation** at ~$60K market cap (~85 SOL)
4. **Migration** to PumpSwap AMM (NOT Raydium — changed March 2025)
5. **AMM trading** on PumpSwap with LP + creator + protocol fees

### `create_v2` Instruction — Account Layout

| Index | Account | Signer | Writable | Notes |
|-------|---------|--------|----------|-------|
| 0 | `global` | No | Yes | `["global"]` PDA |
| 1 | `mint` | **Yes** | Yes | **Your vanity keypair's pubkey** |
| 2 | `bonding_curve` | No | Yes | `["bonding-curve", mint]` PDA |
| 3 | `associated_bonding_curve` | No | Yes | Token-2022 ATA for curve |
| 4 | `metadata` | No | Yes | Token-2022 metadata extension |
| 5 | `user` | **Yes** | No | Transaction payer/signer |
| 6 | `system_program` | No | No | `11111111111111111111111111111111` |
| 7 | `token_program` | No | No | Token-2022: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| 8 | `associated_token_program` | No | No | ATA program |
| 9 | `rent` | No | No | Sysvar rent |
| 10-14 | Mayhem accounts | — | — | Only when `is_mayhem_mode: true` |

### `create_v2` Arguments

```
create_v2(
  name: String,
  symbol: String,
  uri: String,
  creator: Pubkey,          // INDEPENDENT of transaction signer
  is_mayhem_mode: bool,
  is_cashback_coin: bool
)
```

### Legacy `create` Instruction (Still Active)

```
Accounts:
  mint           (isMut: true,  isSigner: true)   <-- YOUR VANITY KEYPAIR
  mintAuthority  (isMut: false, isSigner: false)
  bondingCurve   (isMut: true,  isSigner: false)   PDA: ["bonding-curve", mint]
  associatedBondingCurve (isMut: true, isSigner: false)
  global         (isMut: false, isSigner: false)
  mplTokenMetadata (isMut: false, isSigner: false)
  metadata       (isMut: true,  isSigner: false)
  user           (isMut: true,  isSigner: true)    <-- CREATOR WALLET
  systemProgram, tokenProgram, associatedTokenProgram, rent, eventAuthority, program

Args: name (string), symbol (string), uri (string)
```

### Key Changes (2025-2026)

- `create_v2` replaced `create` as recommended (uses Token2022 instead of legacy SPL Token + Metaplex)
- **Mayhem Mode** added — special fee routing option
- **Cashback coin** option — creator fees redirected to traders (permanent, irreversible)
- PumpSwap replaced Raydium as graduation destination (no more 6 SOL migration fee)
- Dynamic fee tiers based on market cap via PumpFees program

---

## 3. Raydium LaunchLab Deep Dive

### How It Works

Launched April 16, 2025, competing directly with pump.fun.

**Two Launch Modes:**
1. **JustSendIt**: Simplified, default settings. 85 SOL graduation threshold.
2. **LaunchLab Mode**: Full customization. Adjustable SOL target (min 30 SOL). Supply allocation (51-80% on curve). Optional vesting. Choice of migration destination (CPMM or AMM v4).

**Lifecycle:**
1. Creator creates token with metadata (name, symbol, image, URI)
2. Token trades on a bonding curve (linear, exponential, or logarithmic)
3. When bonding curve reaches SOL target, it "graduates"
4. SOL + remaining tokens migrate to Raydium CPMM pool (or AMM v4)
5. LP tokens: 90% burned, 10% to creator (default, configurable by platform)
6. **Fee Key NFT** minted to creator (right to claim LP trading fees)
7. Token trades on full AMM pool

### Program Addresses

| Program | Address |
|---------|---------|
| LaunchLab (mainnet) | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` |
| LaunchLab (devnet) | `DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6` |

### Bonding Curve Types

| Curve | Behavior | Best For |
|-------|----------|----------|
| Linear | Constant price increases | Predictable pricing |
| Exponential | Starts low, rapid escalation | Rewarding early buyers |
| Logarithmic | Rapid initial increase, levels off | Gradual entry |

### On-Chain Creator Account

From `raydium-cpi/programs/launch-cpi/src/context.rs`:

```rust
pub struct InitializeV2<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,         // <-- ONLY signer

    /// CHECK: The creator of base token
    #[account()]
    pub creator: UncheckedAccount<'info>,  // <-- NOT a signer, no constraints
}
```

And in the SDK's `instrument.ts`:
```typescript
{ pubkey: creator, isSigner: false, isWritable: false }  // read-only reference
{ pubkey: payer,   isSigner: true,  isWritable: true }   // actual signer
```

### Fee Distribution (All Pool Types)

| Recipient | CLMM/CPMM | AMM v4 |
|-----------|-----------|--------|
| Liquidity Providers | 84% | 88% |
| RAY Buyback | 12% | 12% |
| Treasury | 4% | 0% |

### LaunchLab Fees

| Fee | Amount | Recipient |
|-----|--------|-----------|
| Protocol fee | 0.25% per trade | Raydium protocol |
| Platform fee | 0.75% per trade (Raydium default) | Platform operator |
| Creator fee | Configurable (max 5%) | Token creator |
| **Total** | **~1.0% per trade** | |

### Pool Creation Fees (Direct, Not Via LaunchLab)

| Pool Type | Cost |
|-----------|------|
| CPMM | ~0.3 SOL |
| CLMM | ~0.1 SOL |
| AMM v4 (deprecated) | ~0.6-3 SOL |

### Statistics

- 119,000+ tokens created as of mid-2025
- Graduation rate: ~0.21%
- $1.1B+ volume through LaunchLab platforms in Q2 2025

---

## 4. Vanity Contract Addresses

### How Token Addresses Work on Solana

On Solana, the **mint account's public key IS the token's "contract address."** When creating a token, you provide a keypair — the public key becomes the token address, and the private key must sign the creation transaction.

**You can use any pre-generated keypair.** Both pump.fun and Raydium accept custom mint keypairs:

```typescript
// Standard
const mintKeypair = Keypair.generate();

// Vanity — EQUALLY VALID
const mintKeypair = Keypair.fromSecretKey(storedVanitySecretKey);
```

### Confirmation on Both Platforms

- **Pump.fun**: `mint` has `isSigner: true` in both `create` and `create_v2`
- **Raydium**: Pass as `mintA` + `extraSigners: [pair]` in `createLaunchpad()`

### Grinding Time Estimates (4-Character Suffix)

| Suffix Length | Expected Attempts | CPU Time | GPU Time (V100) |
|---|---|---|---|
| 3 chars | ~195,112 | ~1.2 seconds | < 1 second |
| **4 chars (CLAW/HRMS)** | **~11,316,496** | **~71 seconds** | **< 10 seconds** |
| 5 chars | ~656,356,768 | ~69 minutes | ~12 minutes |

Both "CLAW" and "HRMS" are valid Base58 characters.

### Grinding Tools

| Tool | Type | Speed | Notes |
|---|---|---|---|
| `solana-keygen grind` | CPU | ~0.3 Mh/s | Built-in, `--ends-with CLAW:1` |
| **Solanity** | CUDA GPU | 100x+ faster | Best for batch grinding |
| **SolVanityCL** | OpenCL GPU | Fast | Supports `--ends-with` |

```bash
solana-keygen grind --ends-with CLAW:100
solana-keygen grind --ends-with HRMS:100
```

### Security

- Vanity keypairs are **cryptographically identical** to random keypairs
- **NEVER use online vanity generators** — they could steal the private key
- Store encrypted server-side (AES-256-GCM)
- Private key only needed **once** (at creation). After mint authority transfers to program PDA, secret key is irrelevant
- Risk: if keypair leaks before use, someone could front-run and create an account at that address

---

## 5. Wallet Architecture — The 3 Dev Wallet Modes

### Option A: User Connects Phantom (NON-CUSTODIAL) — Recommended Default

**Flow:**
1. User connects Phantom/Solflare via wallet adapter
2. Server holds the vanity mint keypair
3. Server builds tx, **partial-signs** with vanity mint keypair
4. Serialized partially-signed tx sent to frontend
5. User's Phantom signs (as fee payer)
6. Broadcast — token lives at vanity address

**Advantages:**
- Non-custodial — never hold user funds
- No compliance burden
- User pays gas
- User's established wallet visible as creator

### Option B: Agent Uses Its Own Wallet

**Flow:**
1. Agent already has a Solana keypair (ElizaOS `WALLET_SECRET_KEY`)
2. Server signs with BOTH agent wallet + vanity mint keypair
3. Broadcast directly

**Advantages:**
- Fully autonomous — no user interaction needed
- Agent can buy on creation

### Option C: We Generate a Fresh Wallet

**Flow:**
1. Server generates a fresh Solana keypair
2. User funds it (or platform pre-funds)
3. Server signs with BOTH generated wallet + vanity mint keypair
4. Broadcast, store encrypted keypair for user

**Advantages:**
- Clean dev wallet for the token
- User doesn't need existing Solana wallet

**Disadvantages:**
- Legally custodial if we hold funds
- Must use MPC wallets (Privy, Dynamic, Turnkey) to avoid true custody

### Recommendation

**All three modes share identical transaction-building code** — only the signing step differs. Default to Option A. Use the `creator` field (see next section) to always route fees to the user's address regardless of who pays.

---

## 6. Creator vs Signer — The Critical Discovery

### Pump.fun

From the official pump.fun docs:

> "While in general, `user` and `creator` are the same pubkey, they can be different. For example, on the free coin creation flow, when the first coin buyer also creates the coin on-chain, the creator pubkey is the original coin creator, while user pubkey is the first buyer. This is also the reason why creator pubkey is not required to be a signer for this instruction."

- **`user`** = transaction signer and fee payer
- **`creator`** = address stored in `BondingCurve.creator` that receives trading fees
- These can be **completely different addresses**
- Creator does **NOT** need to sign

### Raydium LaunchLab

From the on-chain CPI context:

```rust
pub payer: Signer<'info>,                    // ONLY signer
pub creator: UncheckedAccount<'info>,         // NOT a signer, no constraints
```

- The SDK hardcodes `creator = this.scope.ownerPubKey` but the on-chain program accepts ANY address
- Fee Key NFT is minted to the `creator` address
- Build instructions manually to set a different creator

### Impact on Our Architecture

| Mode | Who pays (`user`/signer) | Who earns fees (`creator`) |
|------|--------------------------|---------------------------|
| User Phantom | User's Phantom | User's Phantom |
| Agent wallet | Agent keypair | **User's wallet** (set via creator arg) |
| Generated wallet | Fresh keypair | **User's wallet** (set via creator arg) |

**In all cases, the user's wallet earns creator fees.** The agent/generated wallet just pays for the transaction.

---

## 7. Transaction Co-Signing Flows

### Pump.fun — User Phantom (Partial Signing)

```typescript
// === SERVER SIDE ===
const vanityMintKeypair = Keypair.fromSecretKey(decryptedVanitySecretKey);

const response = await fetch("https://pumpportal.fun/api/trade-local", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    publicKey: userPublicKey,       // Phantom wallet is payer
    action: "create",
    tokenMetadata: { name, symbol, uri: metadataUri },
    mint: vanityMintKeypair.publicKey.toBase58(),
    denominatedInSol: "true",
    amount: devBuySol,
    slippage: 10,
    priorityFee: 0.00005,
    pool: "pump",
  }),
});

const data = await response.arrayBuffer();
const tx = VersionedTransaction.deserialize(new Uint8Array(data));

// Server signs with mint keypair only
tx.sign([vanityMintKeypair]);

const partiallySignedTxBase64 = Buffer.from(tx.serialize()).toString("base64");
// Send to frontend via API response
```

```typescript
// === CLIENT SIDE (Browser) ===
const txBytes = Buffer.from(txBase64FromServer, "base64");
const tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));

// Phantom signs — adds user signature
const signedTx = await wallet.signTransaction(tx);

// Broadcast
const sig = await connection.sendRawTransaction(signedTx.serialize());
```

### Pump.fun — Agent Wallet (Full Server-Side)

```typescript
const agentKeypair = Keypair.fromSecretKey(bs58.decode(agentSecretKey));
const vanityMintKeypair = await loadVanityKeypair(keypairId);

const response = await fetch("https://pumpportal.fun/api/trade-local", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    publicKey: agentKeypair.publicKey.toBase58(),
    action: "create",
    tokenMetadata: { name, symbol, uri: metadataUri },
    mint: vanityMintKeypair.publicKey.toBase58(),
    denominatedInSol: "true",
    amount: devBuySol,
    slippage: 10,
    priorityFee: 0.00005,
    pool: "pump",
  }),
});

const data = await response.arrayBuffer();
const tx = VersionedTransaction.deserialize(new Uint8Array(data));

// Both keypairs sign server-side
tx.sign([vanityMintKeypair, agentKeypair]);

const sig = await connection.sendTransaction(tx);
```

### Pump.fun — Separate Creator from Payer (via @pump-fun/pump-sdk)

PumpPortal's `trade-local` doesn't expose the `creator` arg separately. Use `@pump-fun/pump-sdk` directly:

```typescript
import { PumpSdk } from "@pump-fun/pump-sdk";

const sdk = new PumpSdk({ connection });

const createIx = await sdk.createV2Instruction({
  mint: mintKeypair.publicKey,
  name: "MyToken",
  symbol: "MYTK",
  uri: metadataUri,
  creator: userPublicKey,          // USER wallet earns all fees
  user: agentKeypair.publicKey,    // AGENT wallet pays/signs
  mayhemMode: false,
});

const buyIx = await sdk.buyInstruction({
  mint: mintKeypair.publicKey,
  user: agentKeypair.publicKey,
  solAmount: BigInt(50_000_000),   // 0.05 SOL
  slippageBasisPoints: 1000n,
});

const { blockhash } = await connection.getLatestBlockhash();
const tx = new Transaction({ recentBlockhash: blockhash, feePayer: agentKeypair.publicKey });
tx.add(createIx, buyIx);

// Sign — mint and agent sign; user does NOT need to sign
tx.sign(mintKeypair, agentKeypair);

const sig = await connection.sendRawTransaction(tx.serialize());
```

### Raydium LaunchLab — Agent Wallet (Full Server-Side)

```typescript
import { Raydium, TxVersion, LAUNCHPAD_PROGRAM } from "@raydium-io/raydium-sdk-v2";

const raydium = await Raydium.load({
  connection,
  owner: agentKeypair,    // agent wallet as payer
  cluster: "mainnet",
});

const { execute, extInfo } = await raydium.launchpad.createLaunchpad({
  programId: LAUNCHPAD_PROGRAM,
  mintA: vanityMintKeypair.publicKey,
  decimals: 6,
  name: "Agent Token",
  symbol: "AGENT",
  migrateType: "cpmm",
  uri: metadataUri,
  configId,
  configInfo,
  mintBDecimals: mintBInfo.decimals,
  txVersion: TxVersion.V0,
  slippage: new BN(100),
  buyAmount: new BN(1000),
  createOnly: true,
  extraSigners: [vanityMintKeypair],
  // platformId: clawvillePlatformId,  // earn platform fees
});

await execute({ sequentially: true });
```

### Raydium LaunchLab — User Phantom (Partial Signing)

The SDK hardcodes `creator = ownerPubKey`. For hybrid signing, bypass the SDK and build instructions manually:

1. Build the instruction using SDK's instruction builders
2. Create a `VersionedTransaction`
3. Server partial-signs with vanity mint keypair
4. Serialize and send to browser
5. Phantom signs (payer signature)
6. Browser broadcasts

OR use the SDK with `signAllTransactions`:

```typescript
const raydium = await Raydium.load({
  owner: wallet.publicKey,                       // just the PublicKey
  signAllTransactions: wallet.signAllTransactions, // Phantom callback
  connection,
});
```

---

## 8. Creator Fees

### Pump.fun — Bonding Curve Phase

- Fees accumulate in `creator_vault` PDA: `["creator-vault", creator]`
- **One vault per creator across ALL their tokens**
- Anyone can call `collect_creator_fee` (permissionless) — drains to creator's address
- Fee rate: 0.3% of each trade (configurable via PumpFees)

### Pump.fun — Post-Graduation (PumpSwap AMM)

- `coin_creator` field set on Pool, derived from `BondingCurve.creator` at migration
- Fees accumulate as WSOL in `coin_creator_vault_ata`
- Creator calls `collect_coin_creator_fee`
- Dynamic fee: 0.05-0.95% depending on market cap tier

### Pump.fun — Fee Sharing

- Via `SharingConfig` (PumpFees program), up to 10 wallets can receive shares
- **Limited to one redirect post-creation, then permanently locked**
- `admin_set_creator` exists but only callable by pump.fun team

### Raydium LaunchLab — Pre-Migration

- `creatorFeeRate`: configurable up to 5% (50000 bps)
- Fees claimable via `claimCreatorFee()`

### Raydium LaunchLab — Post-Migration

- **Fee Key NFT** minted to creator's wallet at graduation
- Whoever holds the NFT earns 10% of all LP trading fees
- **NFT is transferable** — can give fee rights to another wallet
- Claimed via `harvestLockLp()`
- If burned or lost, fee rights permanently forfeited

### Rug Perception

If an agent wallet (no tx history) is the creator, traders may see it as suspicious. Mitigations:
- Set `creator` to user's established Phantom wallet
- Keep dev buy small (0.01-0.05 SOL)
- Show "ClawVille Agent" badge in token description
- Use fee sharing to distribute creator fees

---

## 9. PumpPortal API

### Endpoints

| Mode | Endpoint | Auth |
|------|----------|------|
| Local (self-sign) | `POST https://pumpportal.fun/api/trade-local` | None |
| Lightning (API key) | `POST https://pumpportal.fun/api/trade?api-key={key}` | API key in query |
| Jito Bundle | Send array to `trade-local`, submit to Jito block engine | None |

### Token Creation Request (Local)

```typescript
{
  publicKey: signerKeypair.publicKey.toBase58(),  // dev wallet pubkey
  action: "create",
  tokenMetadata: {
    name: "MyToken",
    symbol: "MYTK",
    uri: "https://ipfs.io/ipfs/QmXxx",            // MUST be pre-uploaded
  },
  mint: mintKeypair.publicKey.toBase58(),           // vanity mint pubkey
  denominatedInSol: "true",
  amount: 0.05,           // dev buy in SOL (0 = no dev buy)
  slippage: 10,
  priorityFee: 0.00001,
  pool: "pump",
}
```

**Response:** Raw `VersionedTransaction` bytes (ArrayBuffer). Deserialize and sign with BOTH mint + dev wallet keypairs.

### Lightning API

The `mint` field takes the **full base58-encoded secret key** (not public key). PumpPortal signs on your behalf. Returns `{ signature: "..." }` directly.

### Jito Bundle — Atomic Create + Dev Buy

```typescript
const response = await fetch("https://pumpportal.fun/api/trade-local", {
  method: "POST",
  body: JSON.stringify([
    {
      publicKey: creator.publicKey.toBase58(),
      action: "create",
      tokenMetadata: { name, symbol, uri },
      mint: mintKeypair.publicKey.toBase58(),
      denominatedInSol: "true",
      amount: 1.0,
      slippage: 10,
      priorityFee: 0.02,    // becomes the Jito tip
      pool: "pump",
    },
    {
      publicKey: buyer1.publicKey.toBase58(),
      action: "buy",
      mint: mintKeypair.publicKey.toBase58(),
      denominatedInSol: "true",
      amount: 2.0,
      slippage: 10,
      priorityFee: 0,
      pool: "pump",
    },
    // up to 5 total transactions per bundle
  ])
});

const transactions = await response.json();

const signedTxs = transactions.map((txBase58, i) => {
  const tx = VersionedTransaction.deserialize(new Uint8Array(bs58.decode(txBase58)));
  if (i === 0) tx.sign([mintKeypair, creator]);
  else if (i === 1) tx.sign([buyer1]);
  return bs58.encode(tx.serialize());
});

// Submit to Jito
await fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
  method: "POST",
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1,
    method: "sendBundle",
    params: [signedTxs],
  }),
});
```

### Fees & Rate Limits

- No additional fee for creation. 0.5% API fee on trading portion only.
- **25 requests per second** (Local + Lightning combined)
- WebSocket: 200 subscription msgs/sec, 15 concurrent connections max
- **Mainnet only** — no devnet/testnet

### IPFS Metadata Upload (Required Before Creation)

```typescript
// 1. Upload image
const imageForm = new FormData();
imageForm.append("file", imageBlob);
imageForm.append("network", "public");
const imgRes = await fetch("https://uploads.pinata.cloud/v3/files", {
  method: "POST",
  headers: { Authorization: `Bearer ${PINATA_JWT}` },
  body: imageForm,
});
const { data: { cid: imageCid } } = await imgRes.json();

// 2. Upload metadata JSON
const metadata = {
  name: "MyToken",
  symbol: "MYTK",
  description: "Description",
  image: `https://ipfs.io/ipfs/${imageCid}`,
  twitter: "https://x.com/handle",
  telegram: "https://t.me/group",
  website: "https://example.com",
};
const metaForm = new FormData();
metaForm.append("file", new File([JSON.stringify(metadata)], "metadata.json"));
metaForm.append("network", "public");
const metaRes = await fetch("https://uploads.pinata.cloud/v3/files", {
  method: "POST",
  headers: { Authorization: `Bearer ${PINATA_JWT}` },
  body: metaForm,
});
const { data: { cid: metadataCid } } = await metaRes.json();
const uri = `https://ipfs.io/ipfs/${metadataCid}`;
```

---

## 10. Raydium SDK Integration

### Installation

```bash
npm install @raydium-io/raydium-sdk-v2
# Peer deps:
# @solana/web3.js ^1.95.3
# @solana/spl-token ^0.4.8
# axios ^1.1.3
# bn.js, decimal.js-light
```

### SDK Initialization

```typescript
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const owner = Keypair.fromSecretKey(/* wallet secret key */);

const raydium = await Raydium.load({
  connection,
  owner,
  cluster: "mainnet",
});
```

### API Endpoints

- **Mainnet**: `https://api-v3.raydium.io/`
- **Devnet**: `https://api-v3-devnet.raydium.io/`
- **Swagger**: `https://api-v3.raydium.io/docs/`

### Key SDK Modules

```
raydium.launchpad   — LaunchLab operations
raydium.cpmm        — CPMM pool operations
raydium.clmm        — CLMM pool operations
raydium.liquidity    — AMM v4 pool operations
raydium.tradeV2      — Swap routing
raydium.token        — Token registry/metadata
raydium.api          — API client
```

### Full createLaunchpad Call

```typescript
import {
  TxVersion, LAUNCHPAD_PROGRAM,
  getPdaLaunchpadConfigId, LaunchpadConfig,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';

const pair = Keypair.generate();  // OR load vanity keypair
const mintA = pair.publicKey;

const configId = getPdaLaunchpadConfigId(LAUNCHPAD_PROGRAM, NATIVE_MINT, 0, 0).publicKey;
const configData = await raydium.connection.getAccountInfo(configId);
const configInfo = LaunchpadConfig.decode(configData.data);
const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB);

const { execute, transactions, extInfo } = await raydium.launchpad.createLaunchpad({
  programId: LAUNCHPAD_PROGRAM,
  mintA,
  decimals: 6,
  name: 'Agent Token Name',
  symbol: 'AGENT',
  migrateType: 'cpmm',
  uri: 'https://ipfs.io/ipfs/...metadata.json',
  configId,
  configInfo,
  mintBDecimals: mintBInfo.decimals,
  txVersion: TxVersion.V0,
  slippage: new BN(100),
  buyAmount: new BN(1000),
  createOnly: true,
  extraSigners: [pair],
  // platformId: clawvillePlatformId,
  // supply, totalSellA, totalFundRaisingB — optional advanced params
});

const sentInfo = await execute({ sequentially: true });
```

### Buy/Sell on Bonding Curve

```typescript
import { Curve, PlatformConfig, getPdaLaunchpadPoolId } from '@raydium-io/raydium-sdk-v2';

const poolId = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintA, NATIVE_MINT).publicKey;
const poolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId });
const platformData = await raydium.connection.getAccountInfo(poolInfo.platformId);
const platformInfo = PlatformConfig.decode(platformData.data);

// Buy
const { execute } = await raydium.launchpad.buyToken({
  programId: LAUNCHPAD_PROGRAM,
  mintA,
  mintAProgram: new PublicKey(mintInfo.programId),
  poolInfo,
  slippage: new BN(100),
  configInfo: poolInfo.configInfo,
  platformFeeRate: platformInfo.feeRate,
  txVersion: TxVersion.V0,
  buyAmount: new BN(1_000_000_000),  // lamports
});
await execute({ sendAndConfirm: true });

// Sell
const { execute: executeSell } = await raydium.launchpad.sellToken({
  programId: LAUNCHPAD_PROGRAM,
  mintA,
  mintAProgram: new PublicKey(mintInfo.programId),
  poolInfo,
  configInfo: poolInfo.configInfo,
  platformFeeRate: platformInfo.feeRate,
  txVersion: TxVersion.V0,
  sellAmount: new BN(100000),
});
await executeSell({ sendAndConfirm: true });
```

### Partial Signing Support

**Path A — Keypair owner (server-side):**
```typescript
const raydium = await Raydium.load({ owner: keypair, connection });
// execute() signs with keypair + extraSigners
```

**Path B — PublicKey owner (browser wallet):**
```typescript
const raydium = await Raydium.load({
  owner: wallet.publicKey,
  signAllTransactions: wallet.signAllTransactions,
  connection,
});
```

**Getting raw transactions without broadcasting:**
```typescript
const { execute, transactions } = await raydium.launchpad.createLaunchpad({...});
const { signedTxs } = await execute({ notSendToRpc: true, sequentially: true });
```

---

## 11. ElizaOS Integration

### Existing Plugins

- **`@elizaos/plugin-solana`** — official, has `CREATE_AND_BUY_TOKEN` action
- **`@openpump/eliza-plugin`** — community, wraps PumpPortal with Jito MEV protection
- **`T-rustdev/eliza-solana-plugin-pumpfun-token-launch-ai-agent`** — community fork

All use agent's `WALLET_SECRET_KEY` as both payer and creator. No browser wallet co-signing.

### Custom Action for ClawVille

```typescript
// packages/agent-runtime/src/actions/launch-token.ts

import { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export const launchTokenAction: Action = {
  name: "LAUNCH_TOKEN",
  description: "Launch a new token on pump.fun",
  similes: ["CREATE_TOKEN", "DEPLOY_TOKEN", "MINT_TOKEN"],

  validate: async (runtime: IAgentRuntime) => {
    return !!runtime.getSetting("WALLET_SECRET_KEY");
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const secretKey = runtime.getSetting("WALLET_SECRET_KEY");
    const agentKeypair = Keypair.fromSecretKey(bs58.decode(secretKey));

    const { name, symbol, description, imageUrl, devBuySol } =
      await extractTokenParams(runtime, message);

    const metadataUri = await uploadTokenMetadata({ name, symbol, description, imageUrl });
    const mintKeypair = await loadVanityMintKeypair(agentKeypair.publicKey);

    const result = await launchToken({
      agentSecretKey: secretKey,
      mintKeypair,
      metadataUri,
      name,
      symbol,
      devBuySol: devBuySol ?? 0.05,
    });

    return {
      text: `Token launched! Mint: ${result.mint}. View at pump.fun/${result.mint}`,
      data: result,
    };
  },

  examples: [[
    { user: "{{user1}}", content: { text: "Launch my CLAW token" } },
    { user: "{{agent}}", content: { text: "Token launched! Mint: XXXXpump" } },
  ]],
};
```

### Solana Agent Kit

```typescript
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";

const keyPair = Keypair.fromSecretKey(bs58.decode("SECRET_KEY"));
const wallet = new KeypairWallet(keyPair);
const agent = new SolanaAgentKit(wallet, "RPC_URL", { OPENAI_API_KEY });
```

### PumpDotFun SDK (Direct)

```typescript
import { PumpFunSDK } from "pumpdotfun-sdk";

const sdk = new PumpFunSDK(provider);
const result = await sdk.createAndBuy(
  creatorKeypair,    // dev wallet
  mintKeypair,       // vanity mint
  { name, symbol, description, file: imageBlob },
  buyAmountSol,
  slippageBasisPoints,
  priorityFees,
);
```

---

## 12. Existing Agent Launch Platforms

### Virtuals Protocol (Base chain)
- Creator pays 100 VIRTUAL
- Bonding curve initialized with creator's wallet
- 60% revenue to agent wallet, 30% buyback/burn
- Agent wallet model — deployer is creator

### Believe.app (Meteora-based)
- Users tweet to trigger token creation
- Platform deploys entirely (custodial)
- Creator fees distributed daily after X account linking
- On-chain creator is Believe's platform wallet

### AI16z / ELIZA
- Agent's own keypair as creator
- No user wallet involvement
- Fully autonomous

### Common Pattern
Most agent platforms use the agent's wallet as both payer and creator. No platform currently offers vanity CAs — **this is a differentiator for ClawVille**.

---

## 13. ClawVille Platform Registration

### Raydium LaunchLab Platform

ClawVille can register as a branded LaunchLab platform:

```typescript
await raydium.launchpad.createPlatformConfig({
  programId: LAUNCHPAD_PROGRAM,
  platformAdmin: clawvilleWallet,
  platformClaimFeeWallet: clawvilleWallet,
  platformLockNftWallet: clawvilleWallet,
  platformVestingWallet: vestingAddr,
  cpConfigId: configPublicKey,
  transferFeeExtensionAuth: authAddr,
  creatorFeeRate: new BN(5000),       // 0.5% creator fee
  feeRate: new BN(10000),             // 1% platform fee
  migrateCpLockNftScale: {
    platformScale: new BN(100000),    // 10% LP to ClawVille
    creatorScale: new BN(100000),     // 10% LP to creator
    burnScale: new BN(800000),        // 80% LP burned
  },
  name: 'ClawVille',
  web: 'https://clawville.io',
  img: 'https://clawville.io/logo.png',
  txVersion: TxVersion.V0,
});
```

**Each wallet can only create ONE platform config.** Store the returned `platformId` in env vars.

**Benefits:**
- Earn platform fees on every agent token trade
- Earn platform Fee Key NFT for LP share post-graduation
- Branded launch pages
- Track all tokens launched under ClawVille

### Pump.fun

Pump.fun does NOT support custom platforms. All launches go through their program directly. No platform fee mechanism for third parties.

---

## 14. Recommended Architecture

### Vanity Mint Assignment Flow

```
User connects OpenClaw/Hermes agent
  → ClawVille assigns XXXCLAW or XXXHRMS vanity mint from pool
  → Mint keypair encrypted in DB, indexed by (userId, mintPubkey)
  → User chooses dev wallet mode (Phantom / agent / generated)
  → Launch proceeds
```

### Unified Launch Service

```typescript
type DevWalletMode =
  | { type: "user"; userPublicKey: string }           // Phantom
  | { type: "agent"; agentSecretKey: string }         // agent's own wallet
  | { type: "generated" }                              // fresh keypair

export async function prepareLaunch(params: {
  mode: DevWalletMode;
  mintPubkey: string;
  creatorAddress: string;       // always the user's wallet
  platform: "pumpfun" | "raydium";
  name: string;
  symbol: string;
  metadataUri: string;
  devBuySol: number;
}): Promise<
  | { status: "ready"; signature: string }             // agent/generated
  | { status: "needs_user_sig"; txBase64: string }     // phantom
>
```

### Creator Fee Routing

**Always set `creator` to the user's own Solana wallet**, regardless of who pays:
- User earns fees directly
- User's established wallet visible as creator on pump.fun/DEX Screener
- Agent pays and holds dev buy tokens

### Pre-Launch Checklist

1. `connection.simulateTransaction(tx)` — check for errors
2. Confirm dev wallet has enough SOL (creation + dev buy + priority fee)
3. Verify IPFS metadata URI is accessible (fetch to confirm 200)
4. Confirm mint keypair hasn't been used (check if bonding curve PDA exists)
5. Use Helius `getPriorityFeeEstimate` for current priority fee

### Required Dependencies

```json
{
  "@raydium-io/raydium-sdk-v2": "latest",
  "@solana/web3.js": "^1.95.3",
  "@solana/spl-token": "^0.4.8",
  "@solana/wallet-adapter-react": "latest",
  "@pump-fun/pump-sdk": "latest",
  "bn.js": "^5.2.1",
  "bs58": "^6.0.0"
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VANITY_ENCRYPTION_KEY` | 64-char hex (32 bytes) for AES-256-GCM |
| `DATABASE_URL` | PostgreSQL connection string |
| `SOLANA_RPC_URL` | Solana RPC endpoint |
| `PINATA_JWT` | For IPFS metadata upload |
| `PINATA_GATEWAY` | Pinata gateway URL |
| `CLAWVILLE_PLATFORM_ID` | Raydium LaunchLab platform PDA (after registration) |

### File Locations

| File | Purpose |
|------|---------|
| `packages/database/src/schema/token-launch.ts` | DB schema (vanity_keypairs + token_launches) |
| `apps/api/src/services/keypair-vault.ts` | Encryption, import, reserve, load |
| `apps/api/src/services/token-launch-service.ts` | Unified launch service (TODO) |
| `apps/api/src/routes/token-launch.ts` | API routes (TODO) |
| `apps/web/src/components/game/token-launch-modal.tsx` | Frontend UI (TODO) |
| `scripts/import-vanity-keypairs.ts` | Bulk import CLI |
| `docs/agent-token-launch-setup.md` | Setup instructions |

---

## 15. Implementation Checklist

- [x] Landing page launch section
- [x] DB schema (vanity_keypairs + token_launches)
- [x] Keypair vault encryption service
- [x] Bulk import script
- [x] Setup documentation
- [x] Research documentation (this file)
- [ ] IPFS metadata upload service (Pinata)
- [ ] Unified token launch service (pump.fun + Raydium)
- [ ] API routes (prepare-create, launch, status)
- [ ] Frontend token launch modal
- [ ] Wallet adapter integration (@solana/wallet-adapter-react)
- [ ] Raydium LaunchLab platform registration (one-time)
- [ ] ElizaOS launch-token action
- [ ] Creator fee claim service
- [ ] Launch status monitoring (WebSocket or polling)

---

## 16. Sources

### Pump.fun
- [PumpPortal Token Creation API](https://pumpportal.fun/creation/)
- [PumpPortal FAQ](https://pumpportal.fun/FAQ/)
- [PumpPortal Jito Bundles](https://pumpportal.fun/local-trading-api/jito-bundles/)
- [pump-fun/pump-public-docs (GitHub)](https://github.com/pump-fun/pump-public-docs)
- [Pump Program Instructions (DeepWiki)](https://deepwiki.com/pump-fun/pump-public-docs/3.3-pump-program-instructions)
- [PumpSwap Creator Fee (DeepWiki)](https://deepwiki.com/pump-fun/pump-public-docs/4.2-pumpswap-creator-fee-implementation)
- [Pump Creator Fee (DeepWiki)](https://deepwiki.com/pump-fun/pump-public-docs/3.2-pump-creator-fee-implementation)
- [nirholas/pump-fun-sdk (GitHub)](https://github.com/nirholas/pump-fun-sdk)
- [rckprtr/pumpdotfun-sdk (GitHub)](https://github.com/rckprtr/pumpdotfun-sdk)
- [Pump.fun Fees](https://pump.fun/docs/fees)
- [Pump.fun IDL v0.1.0 (Gist)](https://gist.github.com/rubpy/d8db121af1224a0e4a57f3a7a090f629)

### Raydium
- [Raydium LaunchLab Docs](https://docs.raydium.io/raydium/launchlab/launchlab)
- [LaunchLab TypeScript SDK](https://docs.raydium.io/raydium/pool-creation/launchlab/launchlab-typescript-sdk)
- [Creating a Platform](https://docs.raydium.io/raydium/build/developer-guides/index/creating-a-platform)
- [Collecting Fees](https://docs.raydium.io/raydium/build/developer-guides/index/collecting-fees)
- [Creator Fee Share](https://docs.raydium.io/raydium/launchlab/for-creators/how-creator-fees-work)
- [Creating a Token](https://docs.raydium.io/raydium/launchlab/for-creators/creating-a-token)
- [Protocol Fees](https://docs.raydium.io/raydium/protocol/protocol-fees)
- [Pool Creation Fees](https://docs.raydium.io/raydium/pool-creation/pool-creation-fees)
- [Raydium SDK V2 (GitHub)](https://github.com/raydium-io/raydium-sdk-V2)
- [Raydium SDK V2 Demo — Launchpad](https://github.com/raydium-io/raydium-sdk-V2-demo/tree/master/src/launchpad)
- [Raydium CPI Context](https://github.com/raydium-io/raydium-cpi/blob/master/programs/launch-cpi/src/context.rs)
- [Raydium API v3 Swagger](https://api-v3.raydium.io/docs/)
- [Raydium SDK V2 (DeepWiki)](https://deepwiki.com/raydium-io/raydium-sdk-V2/1-overview)

### Solana & Wallets
- [Solana Token Program Docs](https://spl.solana.com/token)
- [Solana Create a Token Mint](https://solana.com/docs/tokens/basics/create-mint)
- [Metaplex Vanity Public Key Guide](https://metaplex.com/docs/solana/grind-vanity-public-key)
- [Solana Vanity Probability Analysis](https://blog.itswincer.com/posts/solana-vanity-prefix-vs-suffix-probability-en/)
- [Solanity GPU Grinder (GitHub)](https://github.com/mcf-rocks/solanity)
- [Solana Offline Transactions](https://solana.com/developers/cookbook/transactions/offline-transactions)
- [Multi-Signer Transactions (Shyft)](https://docs.shyft.to/dev-guides/solana/transactions/how-to-sign-transactions-using-multiple-signers-on-solana)

### Agent Frameworks
- [elizaos-plugins/plugin-solana (GitHub)](https://github.com/elizaos-plugins/plugin-solana)
- [sendaifun/solana-agent-kit (GitHub)](https://github.com/sendaifun/solana-agent-kit)
- [OpenPump (GitHub)](https://github.com/openpumpio)
- [ElizaOS Pump.fun Plugin](https://github.com/T-rustdev/eliza-solana-plugin-pumpfun-token-launch-ai-agent)
- [Solana Agent Kit — Raydium Integration](https://docs.sendai.fun/docs/v2/integrations/defi-integration/raydium_pools)

### Comparisons
- [PumpSwap vs Raydium vs Orca (Medium)](https://medium.com/@jump_bit/pumpswap-vs-raydium-vs-orca-best-dex-for-pump-fun-tokens-in-2026-3a0b313f828c)
- [Raydium LaunchLab vs pump.fun (HackerNoon)](https://hackernoon.com/raydiums-launchlab-tries-to-fix-its-pumpfun-problemwill-it-work)
- [Raydium Q2 2025 Report (Messari)](https://messari.io/report/state-of-raydium-q2-2025)
- [Virtuals Protocol Whitepaper](https://whitepaper.virtuals.io/about-virtuals/agent-tokenization-platform-launchpad/unicorn-launch-mechanics)
- [What Is Believe? (CoinGecko)](https://www.coingecko.com/learn/what-is-believe-token-launchpad)
