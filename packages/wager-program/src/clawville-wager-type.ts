/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/clawville_wager.json`.
 */
export type ClawvilleWager = {
  "address": "HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG",
  "metadata": {
    "name": "clawvilleWager",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "ClawVille generic wager escrow + lobby program"
  },
  "instructions": [
    {
      "name": "cancelLobby",
      "discriminator": [
        241,
        47,
        118,
        95,
        81,
        67,
        137,
        13
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "lobby",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "signer",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "claimRefundSol",
      "discriminator": [
        8,
        82,
        5,
        144,
        194,
        114,
        255,
        20
      ],
      "accounts": [
        {
          "name": "lobby",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              },
              {
                "kind": "account",
                "path": "playerSigner"
              }
            ]
          }
        },
        {
          "name": "playerSigner",
          "writable": true,
          "signer": true
        },
        {
          "name": "creator",
          "docs": [
            "last refund."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "claimRefundSpl",
      "discriminator": [
        61,
        182,
        225,
        248,
        83,
        117,
        246,
        139
      ],
      "accounts": [
        {
          "name": "lobby",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              },
              {
                "kind": "account",
                "path": "playerSigner"
              }
            ]
          }
        },
        {
          "name": "playerSigner",
          "writable": true,
          "signer": true
        },
        {
          "name": "creator",
          "docs": [
            "ATA rent on the last refund."
          ],
          "writable": true
        },
        {
          "name": "wagerMintAccount"
        },
        {
          "name": "playerTokenAccount",
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "wagerMintAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "cleanupCancelledLobbySol",
      "docs": [
        "Creator-only sweep of a Cancelled SOL lobby's vault residual after the",
        "grace period elapses (`Lobby::GRACE_SECONDS`).",
        "",
        "SPLIT RULE — DO NOT regress to \"all-to-creator\":",
        "The vault residual is split into two portions. The creator recovers",
        "ONLY the original `space=0` PDA rent they paid at create-time",
        "(~0.0009 SOL). Every additional lamport in the vault came from a",
        "player deposit that was never refund-claimed; those go to the",
        "`gambling_treasury` snapshotted at create-time, NOT the creator. This",
        "removes a rug-cancel incentive: without the split, a creator could",
        "open a high-wager lobby, attract deposits, cancel, wait 7 days, and",
        "pocket the entire pot via this instruction. With the split the",
        "creator only recovers their own rent — same economic position they'd",
        "be in if no players had joined at all.",
        "",
        "Abandoned Player PDAs are intentionally untouched — their rent stays",
        "with the players who never claimed a refund."
      ],
      "discriminator": [
        38,
        245,
        159,
        193,
        133,
        74,
        121,
        65
      ],
      "accounts": [
        {
          "name": "lobby",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "treasury",
          "docs": [
            "all unclaimed player deposits."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "cleanupCancelledLobbySpl",
      "docs": [
        "Creator-only sweep of a Cancelled SPL lobby's vault token residual +",
        "vault ATA close + SOL vault rent, after the grace period elapses.",
        "",
        "SPLIT RULE — mirrors the SOL variant: all unclaimed wager TOKENS are",
        "routed to the treasury's ATA (not the creator). The creator only",
        "recovers (a) the SOL rent on the `space=0` vault PDA and (b) the SOL",
        "rent on the vault ATA via close. The token deposits themselves",
        "belong to the abandoned-deposit treasury bucket — same anti-rug",
        "rationale as the SOL variant."
      ],
      "discriminator": [
        228,
        189,
        158,
        171,
        161,
        23,
        217,
        37
      ],
      "accounts": [
        {
          "name": "lobby",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "wagerMintAccount"
        },
        {
          "name": "vaultTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "wagerMintAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "treasury",
          "docs": [
            "all unclaimed wager tokens (via `treasury_token_account`)."
          ]
        },
        {
          "name": "treasuryTokenAccount",
          "docs": [
            "Treasury's ATA receives all unclaimed wager tokens. `init_if_needed`",
            "so cleanup never bricks because treasury hasn't pre-created the ATA.",
            "Payer is the creator since they're the one calling cleanup."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "treasury"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "wagerMintAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeLoserPlayer",
      "docs": [
        "Loser reclaims rent from their Player PDA after a lobby is settled."
      ],
      "discriminator": [
        158,
        199,
        214,
        93,
        221,
        53,
        75,
        75
      ],
      "accounts": [
        {
          "name": "lobby",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              },
              {
                "kind": "account",
                "path": "playerSigner"
              }
            ]
          }
        },
        {
          "name": "playerSigner",
          "writable": true,
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "createLobbySol",
      "docs": [
        "Create a SOL-denominated or free lobby."
      ],
      "discriminator": [
        213,
        18,
        18,
        186,
        187,
        106,
        78,
        175
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "lobby",
          "writable": true
        },
        {
          "name": "vault",
          "docs": [
            "SOL vault PDA. Always allocated even when `wager_amount == 0` to keep",
            "the account-set uniform across SOL instructions; rent residual returns",
            "to creator on settle/cancel. System-owned (no data, no allocation) —",
            "funded via lamport transfer in the handler. Pre-creating with",
            "`init + space=0` triggers an Anchor 0.31.1 macro codegen bug",
            "(E0425 \"cannot find crate `try_from_unchecked`\") so we self-fund",
            "rent here instead. Address is the deterministic PDA from seeds."
          ],
          "writable": true
        },
        {
          "name": "creatorPlayer",
          "writable": true
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lobbyId",
          "type": "u64"
        },
        {
          "name": "wagerAmount",
          "type": "u64"
        },
        {
          "name": "maxPlayers",
          "type": "u8"
        }
      ]
    },
    {
      "name": "createLobbySpl",
      "docs": [
        "Create an SPL-denominated lobby. Requires wager_amount > 0 and a real mint."
      ],
      "discriminator": [
        58,
        255,
        1,
        31,
        78,
        151,
        149,
        85
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "lobby",
          "writable": true
        },
        {
          "name": "vault",
          "docs": [
            "SOL vault PDA. Authority for the vault ATA. System-owned (no data, no",
            "allocation) — funded via lamport transfer in the handler. Pre-creating",
            "with `init + space=0` triggers an Anchor 0.31.1 macro codegen bug",
            "(E0425 \"cannot find crate `try_from_unchecked`\") so we self-fund",
            "rent here instead. Address is the deterministic PDA from seeds."
          ],
          "writable": true
        },
        {
          "name": "creatorPlayer",
          "writable": true
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "wagerMintAccount"
        },
        {
          "name": "creatorTokenAccount",
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's associated token account; init_if_needed because the same vault",
            "PDA is being created above and its ATA must be allocated atomically."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "wagerMintAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lobbyId",
          "type": "u64"
        },
        {
          "name": "wagerAmount",
          "type": "u64"
        },
        {
          "name": "wagerMint",
          "type": "pubkey"
        },
        {
          "name": "maxPlayers",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "rakeBps",
          "type": "u16"
        },
        {
          "name": "settlementAuthority",
          "type": "pubkey"
        },
        {
          "name": "gamblingTreasury",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "joinLobbySol",
      "discriminator": [
        170,
        39,
        164,
        178,
        237,
        79,
        157,
        84
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "lobby",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "player",
          "docs": [
            "init (NOT init_if_needed) so a second join attempt by the same player",
            "fails with account-already-exists, preventing silent double-join."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              },
              {
                "kind": "account",
                "path": "playerSigner"
              }
            ]
          }
        },
        {
          "name": "playerSigner",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "joinLobbySpl",
      "discriminator": [
        164,
        81,
        20,
        46,
        0,
        137,
        11,
        217
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "lobby",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              },
              {
                "kind": "account",
                "path": "playerSigner"
              }
            ]
          }
        },
        {
          "name": "playerSigner",
          "writable": true,
          "signer": true
        },
        {
          "name": "wagerMintAccount"
        },
        {
          "name": "playerTokenAccount",
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "wagerMintAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "lockLobby",
      "discriminator": [
        8,
        180,
        21,
        189,
        192,
        109,
        29,
        8
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "lobby",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "settlementAuthority",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "settleLobbySol",
      "discriminator": [
        254,
        66,
        206,
        244,
        33,
        118,
        19,
        171
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "lobby",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "winnerPlayer",
          "docs": [
            "Winner's Player PDA — proves the winner joined and is not refunded."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              },
              {
                "kind": "arg",
                "path": "winner"
              }
            ]
          }
        },
        {
          "name": "settlementAuthority",
          "writable": true,
          "signer": true
        },
        {
          "name": "winnerAccount",
          "writable": true
        },
        {
          "name": "treasury",
          "docs": [
            "preventing admin from rerouting rake on in-flight lobbies via update_config."
          ],
          "writable": true
        },
        {
          "name": "creator",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "winner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "settleLobbySpl",
      "discriminator": [
        158,
        21,
        41,
        25,
        160,
        49,
        146,
        87
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "lobby",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  98,
                  98,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              }
            ]
          }
        },
        {
          "name": "winnerPlayer",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lobby.lobby_id",
                "account": "lobby"
              },
              {
                "kind": "arg",
                "path": "winner"
              }
            ]
          }
        },
        {
          "name": "settlementAuthority",
          "writable": true,
          "signer": true
        },
        {
          "name": "winnerAccount",
          "writable": true
        },
        {
          "name": "treasury",
          "docs": [
            "reroute rake on in-flight lobbies."
          ],
          "writable": true
        },
        {
          "name": "creator",
          "writable": true
        },
        {
          "name": "wagerMintAccount"
        },
        {
          "name": "vaultTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "wagerMintAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "winnerTokenAccount",
          "docs": [
            "Winner's ATA, init_if_needed so settlement never fails because the",
            "winner forgot to set up an ATA. Payer = settlement authority.",
            "Boxed to keep try_accounts stack frame under the 4KiB BPF limit."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "winnerAccount"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "wagerMintAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "treasuryTokenAccount",
          "docs": [
            "Treasury's ATA, init_if_needed for the same reason. Boxed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "treasury"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "wagerMintAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "winner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "transferAdmin",
      "discriminator": [
        42,
        242,
        66,
        106,
        228,
        10,
        111,
        156
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateConfig",
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newSettlementAuthority",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "newTreasury",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "newRakeBps",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "newPaused",
          "type": {
            "option": "bool"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "lobby",
      "discriminator": [
        167,
        194,
        217,
        163,
        92,
        92,
        103,
        49
      ]
    },
    {
      "name": "player",
      "discriminator": [
        205,
        222,
        112,
        7,
        165,
        155,
        206,
        218
      ]
    }
  ],
  "events": [
    {
      "name": "adminTransferred",
      "discriminator": [
        255,
        147,
        182,
        5,
        199,
        217,
        38,
        179
      ]
    },
    {
      "name": "configUpdated",
      "discriminator": [
        40,
        241,
        230,
        122,
        11,
        19,
        198,
        194
      ]
    },
    {
      "name": "lobbyCancelled",
      "discriminator": [
        21,
        49,
        85,
        33,
        112,
        122,
        91,
        103
      ]
    },
    {
      "name": "lobbyCleanedUp",
      "discriminator": [
        239,
        250,
        0,
        53,
        49,
        71,
        53,
        238
      ]
    },
    {
      "name": "lobbyCreated",
      "discriminator": [
        109,
        169,
        16,
        50,
        169,
        242,
        237,
        65
      ]
    },
    {
      "name": "lobbyJoined",
      "discriminator": [
        151,
        254,
        144,
        252,
        151,
        246,
        215,
        49
      ]
    },
    {
      "name": "lobbyLocked",
      "discriminator": [
        199,
        157,
        195,
        74,
        53,
        102,
        183,
        243
      ]
    },
    {
      "name": "lobbyRefunded",
      "discriminator": [
        37,
        99,
        34,
        76,
        175,
        241,
        3,
        174
      ]
    },
    {
      "name": "lobbySettled",
      "discriminator": [
        181,
        198,
        5,
        8,
        3,
        224,
        28,
        65
      ]
    },
    {
      "name": "loserPlayerClosed",
      "discriminator": [
        178,
        154,
        57,
        158,
        31,
        225,
        198,
        157
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "rakeTooHigh",
      "msg": "Rake bps exceeds maximum (1000 = 10%)"
    },
    {
      "code": 6001,
      "name": "paused",
      "msg": "Program is paused"
    },
    {
      "code": 6002,
      "name": "invalidLobbyState",
      "msg": "Lobby is not in the required state"
    },
    {
      "code": 6003,
      "name": "lobbyFull",
      "msg": "Lobby is full"
    },
    {
      "code": 6004,
      "name": "notEnoughPlayers",
      "msg": "Not enough players to lock"
    },
    {
      "code": 6005,
      "name": "invalidMaxPlayers",
      "msg": "max_players must be between 2 and 16"
    },
    {
      "code": 6006,
      "name": "unauthorized",
      "msg": "Caller is not authorized"
    },
    {
      "code": 6007,
      "name": "wagerMintMismatch",
      "msg": "Wager mint mismatch"
    },
    {
      "code": 6008,
      "name": "winnerNotJoined",
      "msg": "Winner did not join this lobby"
    },
    {
      "code": 6009,
      "name": "alreadyRefunded",
      "msg": "Already refunded"
    },
    {
      "code": 6010,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6011,
      "name": "accountMismatch",
      "msg": "Provided account does not match recorded value"
    },
    {
      "code": 6012,
      "name": "wrongTokenVariant",
      "msg": "Wrong instruction variant for this lobby (SOL/SPL mismatch)"
    },
    {
      "code": 6013,
      "name": "winnerCannotCloseAsLoser",
      "msg": "Player is the winner; cannot close as loser"
    },
    {
      "code": 6014,
      "name": "gracePeriodNotElapsed",
      "msg": "Cancellation grace period has not yet elapsed"
    }
  ],
  "types": [
    {
      "name": "adminTransferred",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldAdmin",
            "type": "pubkey"
          },
          {
            "name": "newAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "settlementAuthority",
            "type": "pubkey"
          },
          {
            "name": "gamblingTreasury",
            "type": "pubkey"
          },
          {
            "name": "rakeBps",
            "type": "u16"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "configUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "settlementAuthority",
            "type": "pubkey"
          },
          {
            "name": "gamblingTreasury",
            "type": "pubkey"
          },
          {
            "name": "rakeBps",
            "type": "u16"
          },
          {
            "name": "paused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "lobby",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lobbyId",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "wagerAmount",
            "type": "u64"
          },
          {
            "name": "wagerMint",
            "type": "pubkey"
          },
          {
            "name": "maxPlayers",
            "type": "u8"
          },
          {
            "name": "joinedCount",
            "type": "u8"
          },
          {
            "name": "state",
            "type": "u8"
          },
          {
            "name": "winner",
            "type": "pubkey"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "lockedAt",
            "type": "i64"
          },
          {
            "name": "treasurySnapshot",
            "docs": [
              "Treasury captured at create time. Settle uses THIS, not the live config,",
              "so admin cannot redirect rake on in-flight lobbies via update_config."
            ],
            "type": "pubkey"
          },
          {
            "name": "rakeBpsSnapshot",
            "docs": [
              "Rake captured at create time. Same rationale as treasury_snapshot —",
              "admin update_config affects only NEW lobbies."
            ],
            "type": "u16"
          },
          {
            "name": "cancelledAt",
            "docs": [
              "Unix timestamp of when this lobby transitioned to Cancelled. Zero on",
              "any non-cancelled lobby. Drives the grace-period gate in",
              "`cleanup_cancelled_lobby_*` so abandoned-refund residuals can be swept",
              "after `Lobby::GRACE_SECONDS` have elapsed."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "lobbyCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lobbyId",
            "type": "u64"
          },
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "lobbyCleanedUp",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lobbyId",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "creatorLamports",
            "docs": [
              "Lamports returned to creator (rent recovery only)."
            ],
            "type": "u64"
          },
          {
            "name": "treasuryLamports",
            "docs": [
              "Unclaimed SOL deposits routed to treasury (SOL variant only; 0 for SPL)."
            ],
            "type": "u64"
          },
          {
            "name": "treasuryTokens",
            "docs": [
              "Unclaimed token deposits routed to treasury (SPL variant only; 0 for SOL)."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "lobbyCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lobbyId",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "wagerAmount",
            "type": "u64"
          },
          {
            "name": "wagerMint",
            "type": "pubkey"
          },
          {
            "name": "maxPlayers",
            "type": "u8"
          },
          {
            "name": "treasurySnapshot",
            "type": "pubkey"
          },
          {
            "name": "rakeBpsSnapshot",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "lobbyJoined",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lobbyId",
            "type": "u64"
          },
          {
            "name": "player",
            "type": "pubkey"
          },
          {
            "name": "joinedCount",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "lobbyLocked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lobbyId",
            "type": "u64"
          },
          {
            "name": "joinedCount",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "lobbyRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lobbyId",
            "type": "u64"
          },
          {
            "name": "player",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "lobbySettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lobbyId",
            "type": "u64"
          },
          {
            "name": "winner",
            "type": "pubkey"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "rake",
            "type": "u64"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "loserPlayerClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lobbyId",
            "type": "u64"
          },
          {
            "name": "player",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "player",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lobbyId",
            "type": "u64"
          },
          {
            "name": "player",
            "type": "pubkey"
          },
          {
            "name": "depositAmount",
            "type": "u64"
          },
          {
            "name": "refunded",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
