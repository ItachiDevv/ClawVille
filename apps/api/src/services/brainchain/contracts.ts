/** Reviewed manifest snapshot 2026-11-09; no runtime manifest URL can change these addresses. */
export const BRAINCHAIN_CONTRACTS = {
  "mainnet": {
    "chainId": 274663,
    "rpc": "https://rpc.usebrainchain.com",
    "release": "3.5.0",
    "source": "https://raw.githubusercontent.com/usebrainchain/brainchain/main/deployments/mainnet.json",
    "contracts": {
      "board": "0x44b8464342bbfb9b565fae494dfdefa37d33a211",
      "staking": "0xa4351e2b84eb634e93d9082907b2d0d3aa91b98f",
      "bonds": "0x33260cd6b4f368031f5af2b5413d0ce6bb2afaa4",
      "executor": "0xfd268ae2c1ec0db03c3c6b17e1aede973729fe29",
      "brain": "0x3367085eb6c79bfb0fca4f1433ec77bfa8cb8a37",
      "usdg": "0x8ebfece96c0aef7fd23425d846a302a552c8c451"
    },
    "boards": [
      {
        "address": "0x44b8464342bbfb9b565fae494dfdefa37d33a211",
        "fromBlock": 965,
        "release": "3.5.0"
      },
      {
        "address": "0x8385bb4b8990411ccdd8e851b2676da1a4c1f3c4",
        "fromBlock": 839,
        "release": "3.4.0"
      },
      {
        "address": "0x72c890aa996bf7efca88e3f5063b626560215160",
        "fromBlock": 425,
        "release": "3.3.0"
      },
      {
        "address": "0x6fbf25f036f18c7ae3b1b7343ed8d16dc695f6e0",
        "fromBlock": 282,
        "release": "3.1.0"
      },
      {
        "address": "0x33825bc40e43cc7f8a301d6b7ac79edcdb92aca7",
        "fromBlock": 101,
        "release": "3.0.0"
      }
    ]
  },
  "testnet": {
    "chainId": 274630,
    "rpc": "https://rpc.testnet.usebrainchain.com",
    "release": "3.5.0",
    "source": "https://raw.githubusercontent.com/usebrainchain/brainchain/main/deployments/testnet.json",
    "contracts": {
      "board": "0x7a7cc5d35a642ccc268c7b263ff800bc7ebd52a4",
      "staking": "0x6afc3efb49cf9b14c2f7c6c4f6c0bb3ef0125e2b",
      "bonds": "0x2f15b42131544e6763dbecc7c954c7823aaa0d47",
      "executor": "0xa3a40a2d46d54dc6e88c08a9d98ec47785cb2366",
      "brain": "0xc717546497343911750768335b649b86d0a6eccf",
      "usdg": "0xc4ec72794bf3ce9ba1de4b38085464c2eb0cdcf2"
    },
    "boards": [
      {
        "address": "0x7a7cc5d35a642ccc268c7b263ff800bc7ebd52a4",
        "fromBlock": 2288,
        "release": "3.5.0"
      },
      {
        "address": "0x67e0c5f884e1df61ac585b6d158c6e8175956ad1",
        "fromBlock": 2141,
        "release": "3.4.1"
      },
      {
        "address": "0x0bea77333e26a257983fcc59b8d857730b5b1d2b",
        "fromBlock": 1793,
        "release": "3.4.0"
      },
      {
        "address": "0xc74564f100e70f95346a6e399ebf1ce14309c8b6",
        "fromBlock": 898,
        "release": "3.1.0"
      }
    ]
  }
} as const;
export type BrainChainEnvironment = keyof typeof BRAINCHAIN_CONTRACTS;
