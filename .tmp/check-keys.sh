#!/bin/bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
for KEY in id.json windows-key.json mainnet-deployer.json; do
  PUB=$(solana-keygen pubkey ~/.config/solana/$KEY 2>&1)
  BAL=$(solana balance --url https://api.devnet.solana.com --keypair ~/.config/solana/$KEY 2>&1)
  echo "$KEY -> $PUB -> $BAL"
done
