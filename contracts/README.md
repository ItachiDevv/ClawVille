# clawville-wager

A generic on-chain lobby + escrow Anchor program for ClawVille match wagers.
Lobbies progress `Open → Locked → Settled` (or `Open/Locked → Cancelled`).
Two parallel SOL / SPL variants exist for every flow because Anchor 0.31
cannot codegen the `Option<Account<TokenAccount>>` pattern that would have
allowed a single account schema to handle both — see `lib.rs` for details.

## Overview

- `initialize_config` — deploy-time singleton config (admin, settlement
  authority, treasury, rake bps, paused flag).
- `create_lobby_{sol,spl}` — creator opens a lobby and joins as the first
  player; treasury + rake are snapshotted at create-time so admin
  `update_config` cannot reroute rake on in-flight games.
- `join_lobby_{sol,spl}` — additional players deposit and create their
  Player PDA. `init` (not `init_if_needed`) prevents silent double-join.
- `lock_lobby` — settlement authority freezes the roster.
- `settle_lobby_{sol,spl}` — settlement authority declares the winner;
  pot is split into `payout` (winner) + `rake` (treasury_snapshot).
- `cancel_lobby` — creator (Open only) or settlement authority
  (Open or Locked) cancels; players then call `claim_refund_{sol,spl}` to
  recover their deposit.
- `cleanup_cancelled_lobby_{sol,spl}` — creator-only sweep of vault
  residual after `Lobby::GRACE_SECONDS` (7 days) for lobbies whose
  joiners abandoned the refund path. Does NOT touch abandoned Player PDAs.
- `close_loser_player` — losing players reclaim Player PDA rent post-settle.
- `update_config` / `transfer_admin` — admin-only config mutations.

## Trust Model

Settlement authority is the game-server referee that declares winners after
each match. By joining a lobby you are trusting the ClawVille operator to
call match outcomes honestly — same trust model as a dealer at a poker
night. The 10% rake cap only limits the treasury take; **operator integrity
gates the pot itself**. A compromised (or colluding) settlement authority
that joins a lobby — directly or via a sock-puppet joiner — can drain ~90%
of every pot by declaring its own key the winner. Use a multisig +
cold-storage backup for the settlement key in production, and rotate via
`update_config` on any suspicion of compromise.

### Cleanup of cancelled lobbies

When a lobby is cancelled, players have a 7-day window
(`Lobby::GRACE_SECONDS`) to call `claim_refund_{sol,spl}` and recover their
deposit + Player PDA rent. After the window elapses, the creator may call
`cleanup_cancelled_lobby_{sol,spl}` to sweep what's left in the vault. The
sweep is **split** rather than all-to-creator:

- **Creator** receives only the original PDA rent they paid at create-time:
  ~0.0009 SOL for the `space=0` SOL vault, plus the SPL vault ATA rent on
  the SPL variant.
- **Gambling treasury** (snapshotted at `create_lobby`) receives every other
  lamport / token in the vault. Those are unclaimed player deposits.

Why the split: an all-to-creator design enables a "rug-cancel" — open a
high-wager lobby, attract deposits, cancel, wait 7 days, pocket the pot via
cleanup. Treating unclaimed deposits as the casino's "abandoned chips"
removes the incentive while still letting honest creators recover their
rent.

Abandoned Player PDAs are intentionally untouched — that rent belongs to
the players who never claimed a refund, and they (or anyone with their
signer key) can still close them via `claim_refund` in the future.

PDA seeds (deterministic, all `to_le_bytes()` for u64):

- Config: `[b"config"]`
- Lobby: `[b"lobby", lobby_id_le_bytes]`
- Vault: `[b"vault", lobby_id_le_bytes]` (system-owned, `space = 0`)
- Player: `[b"player", lobby_id_le_bytes, player_pubkey]`
- Vault SPL ATA: ATA derived against the vault PDA as authority.

## Toolchain

- **Anchor:** 0.31.1 (pinned via `Anchor.toml`).
- **Solana CLI:** 2.2.14.
- **Rust:** stable, MSRV >= 1.79 (matches Anchor 0.31's requirement).
- **Bun:** any recent version (test runner via `ts-mocha`).

## First-time setup

The repo ships with a placeholder program ID. Before the first build you
need a real keypair so `declare_id!` and the on-chain BPF program ID align.

```bash
# From contracts/
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase --silent \
  -o target/deploy/clawville_wager-keypair.json
anchor keys sync          # rewrites declare_id! + Anchor.toml entries
```

`anchor keys sync` updates both `programs/clawville-wager/src/lib.rs`
(`declare_id!`) and `Anchor.toml`'s `[programs.localnet]` /
`[programs.devnet]` mappings.

## Build

```bash
anchor build
```

Produces:

- `target/deploy/clawville_wager.so` — BPF binary.
- `target/idl/clawville_wager.json` — IDL.
- `target/types/clawville_wager.ts` — TypeScript types consumed by tests.

## Tests

Two test surfaces — a vanilla Anchor suite and a LiteSVM suite for the
clock-warped flows.

```bash
bun install               # once, from repo root

# Anchor suite (solana-test-validator + ts-mocha + chai). Covers happy paths
# (SOL / SPL / free), refund flows, the 10+ negative paths, treasury
# snapshot integrity, the admin-transfer flow, and grace-period gating on
# cleanup. The cleanup HAPPY-path tests are `it.skip`-marked here because
# vanilla solana-test-validator can't warp the cluster clock mid-test —
# coverage is provided by the LiteSVM suite below.
npm run test
# (alias: `anchor test`)

# LiteSVM suite — covers cleanup_cancelled_lobby_{sol,spl} HAPPY paths
# using LiteSVM's `setClock` to warp time past the 7-day grace period.
# Requires `anchor build` + `anchor keys sync` to have already produced
# target/deploy/clawville_wager.so + target/idl/clawville_wager.json.
npm run test:litesvm
```

## Deploy

```bash
# Devnet
anchor deploy --provider.cluster devnet

# Mainnet (only after multisig audit)
anchor deploy --provider.cluster mainnet
```

After deployment, call `initialize_config` exactly once to seed the
singleton Config PDA. Set `settlement_authority` to a multisig in
production.

## Operational notes

- Pause: `update_config(.., new_paused: Some(true))`. `cancel_lobby` and
  `lock_lobby` intentionally bypass the pause check so operators can drain
  in-flight lobbies during maintenance.
- Rotate settlement authority: `update_config(new_settlement_authority,
  ..)`. In-flight lobbies retain their snapshot; only NEW lobbies use the
  new authority for treasury/rake (the authority itself is read live for
  lock/settle/cancel).
- Grace period: 7 days (`Lobby::GRACE_SECONDS`). Tune by changing the
  constant + republishing.
