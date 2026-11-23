# Isolated Linux signer driver fixture

Observed: 2026-11-09. Host: itachi222, Ubuntu-24.04 WSL.
The actual Linux driver fixture passed one test with fourteen assertions under Bun 1.3.14 after audit corrections.
The test used the public-known synthetic private scalar 1. It never accessed the keyring or network.
It first proved the real activation gate refuses before a key file exists.
It then mocked only `assertSignerActivation` inside the isolated test process.
The test verified signature recovery, protected capture, replay after key-file corruption, changed-intent refusal, and mode-0644 refusal.
It also rejected high-bit aliases of hexadecimal bytes and deferred the driver claim while mutating the caller transaction.
The captured transaction retained its original destination, calldata, gas limit, fee ceiling, and nonce.
The production source gate remains false. This fixture does not authorize activation.

The container used UID/GID 10001, no network, read-only root, dropped capabilities, and no-new-privileges.
Limits: 64 processes, 256 MiB memory, one CPU, and a 16 MiB mode-0700 private tmpfs.
The kernel reported unsupported swap limits. No host power-loss or durable-key-volume claim follows from this test.
Only two code artifacts occupied the read-only fixture mount. The synthetic key existed only on the removed container's tmpfs.
All four Hydra containers remained running afterward: hydra-ci-redis, hydra-ci-pg, hydra-redis, and hydra-pg.

Pinned image: `oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`.
Fixture bundle SHA256: `370b1279c7e4681cf8ccc4addce406dbc686d73ab3a0b45c6fe232775eb6255f`.
Policy bundle SHA256: `c212de6e2029c8f44a832d3ca0240eca7fc232058f20f3ceb65bed6ae0c0ff98`.

The initial single-file bundle inlined the gate and correctly refused the synthetic signing step.
The successful build preserved the policy module as a separate, unchanged bundle.
The scratch build plugin marks policy imports external and adds the explicit `.js` suffix in test imports.
It changes no gate implementation or production source. Mock restoration occurs before the test process exits.
Single-file root mounts did not resolve the sibling import; a directory containing only the two bundles resolved it.

Reproduction uses `.brainchain-work/build-signer-fixture.ts` and the two-file `.brainchain-work/signer-driver-fixture` directory:

```powershell
bun build apps/api/src/services/brainchain/signer-policy.ts --target=bun --outfile .brainchain-work/signer-policy.js
bun .brainchain-work/build-signer-fixture.ts
Copy-Item -LiteralPath .brainchain-work/signer-linux-driver-fixture.test.js -Destination .brainchain-work/signer-driver-fixture/fixture.test.js
Copy-Item -LiteralPath .brainchain-work/signer-policy.js -Destination .brainchain-work/signer-driver-fixture/signer-policy.js
wsl -d Ubuntu-24.04 -- docker run --rm --name cv-brainchain-driver-proof --network none --read-only --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1 --tmpfs /journal:rw,nosuid,nodev,noexec,size=16m,uid=10001,gid=10001,mode=0700 --mount type=bind,src=/mnt/c/Users/itachi/Documents/Crypto/ClawVille/.worktrees/brainchain-plan/.brainchain-work/signer-driver-fixture,dst=/fixture,readonly --env BRAINCHAIN_SIGNER_STORE_TEST_ROOT=/journal oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 bun test /fixture/fixture.test.js
```

## Typed delivery increment

The same isolated command now passes one test with 27 assertions, including typed result signatures and submit capture.
It proves separate journal namespaces, cross-type payload rejection, capture before return, replay with a corrupt key file, and revocation after file reads.
Only the synthetic scalar fixture signs. Network access remains disabled and the real activation gate remains false.
Updated fixture bundle SHA256: `e8bdba329eeda31a4bcae990a7be33348cec4fd1b835621fa094ff4c62bb3c5a`.
Updated policy bundle SHA256: `a3adf9b604e9378eee11916e8456c346ac3ac8a6d473c57c8becca4c4b6543ab`.
The four Hydra containers remain present and running after this run.
