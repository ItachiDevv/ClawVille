/** Observed full runtime hashes. Source equivalence review is separate; this file does not authorize signing. */
export const TESTNET_SIGNER_CODE_EVIDENCE = {
  "sourceCommit": "348cc3726227a9a321d7593fd0e685904901d31e",
  "evidenceSha256": "8b46e30860906b587f6ad65ee1e7561fcd201a100de5d93f281dc716837a7862",
  "observedBlock": "0x13ea",
  "chainId": 274630,
  "metadataExact": false,
  "approvedForSigning": false,
  // Additional dependency provenance: docs/brainchain-testnet-artifact-readiness-review.md, block 0x13ec.
  // The original evidence digest and block above refer to the separate five-contract review.
  "contracts": {
    "0x4e4cb48f3802bd519e0eed896df82197b0ecbc09": "0x917216bf47f6d0240fbf0646de38b45f32a4205015cbf61ef26c51b0faa20d58", // DecisionLog
    "0x3e5e23a5ff6548958ab3ddf42c51a59713ce550c": "0xdd1e96eb781459c608ff34b82469c957ce90e408bccaaa39c5c86e60ea6d326b", // ModelRegistry
    "0xc4ec72794bf3ce9ba1de4b38085464c2eb0cdcf2": "0x085a09654a7ff2ea410a62fff9309557c953bf29a0ccaa12b5ef4b830e33c226", // TestUSDG

    "0xc717546497343911750768335b649b86d0a6eccf": "0xac04bf6d10bd33a232640b204c7c6169285328522af4e53d8e84e281a8a08dc9",
    "0x6afc3efb49cf9b14c2f7c6c4f6c0bb3ef0125e2b": "0x4b175fed27f964db80591205f354d5c88f9d3f2a63e6a2d1a42fb7d226313ab9",
    "0x2f15b42131544e6763dbecc7c954c7823aaa0d47": "0x1b1f7b254b9ea86a5c800ee0e4cead8ec18d2ff3fb303f2fb2b876cadc837b1d",
    "0x7a7cc5d35a642ccc268c7b263ff800bc7ebd52a4": "0xe2f68f1f91bc5932997a05d92ffe42eee5a4d657a4245303901e892703380580",
    "0xa3a40a2d46d54dc6e88c08a9d98ec47785cb2366": "0x1c99dc0c88bc25fce3654e3390a07dd6eab159452300711449d95ecf5a2e6bff"
  }
} as const;
