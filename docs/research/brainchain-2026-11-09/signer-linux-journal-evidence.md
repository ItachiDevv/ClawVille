# BrainChain signer Linux journal evidence

Observed:2026-11-09. Host:itachi222, Ubuntu-24.04 WSL, Docker29.1.3.
The lead ran the actual signer-payload-store.test.ts bundle under Linux Bun1.3.14.
The official image digest is sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4.

Result:3passed,1Windows-only test skipped,0failed,11assertions.
The tests exercised one-use key claims, operation-indexed payload reopening, replacement refusal, permission refusal and symlink/path refusal.
No private key or real signed transaction existed in the fixture.

Container controls:UID/GID10001,network none,read-only root,all capabilities dropped,no-new-privileges,pids64,memory256MiB,CPU1.
Only the151.74KB bundled test file was bind-mounted, read-only.
The journal used a16MiB tmpfs with mode0700 and UID/GID10001.
The container was named cv-brainchain-journal-proof and removed after its command exited.
The four existing Hydra containers remained running.

Limits:This proves Linux permission checks and reopening within one process lifetime.
A tmpfs test does not prove persistence after container removal, host reboot or power loss.
The kernel reported that swap limits are unsupported; memory limits exclude swap control.
A durable ext4 store and crash/restart tests remain required before signer activation.
This fixture does not prove API/cognition isolation, actual key custody or transaction broadcast.

Reproduction:

```powershell
bun build apps/api/src/services/brainchain/signer-payload-store.test.ts --target=bun --external bun:test --outfile .brainchain-work/signer-journal-fixture.test.js
wsl -d Ubuntu-24.04 -- docker run --rm --name cv-brainchain-journal-proof --network none --read-only --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1 --tmpfs /journal:rw,nosuid,nodev,noexec,size=16m,uid=10001,gid=10001,mode=0700 --mount type=bind,src=/mnt/c/Users/itachi/Documents/Crypto/ClawVille/.worktrees/brainchain-plan/.brainchain-work/signer-journal-fixture.test.js,dst=/fixture.test.js,readonly --env BRAINCHAIN_SIGNER_STORE_TEST_ROOT=/journal oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 bun test /fixture.test.js
```

## Separate-container persistence proof

The lead then built signer-journal-restart-probe.ts for the same pinned Linux image.
A dedicated named volume cv-brainchain-journal-proof-v1 carries label clawville.job=brainchain-office.
An initialization container set its root to UID/GID10001 and mode0700.
The write container recorded a fixed fake key-use claim and fake payload, then exited and was removed.
A separate read container reopened the same volume and passed its assertions.
Both phases reported result=pass and uid=10001.
The second process refused another key claim, recovered the exact fake bytes, and rejected a changed intent hash.
Both proof containers used no network, read-only root, dropped capabilities and no-new-privileges.
This proves persistence across container/process replacement, not host reboot or power loss.
The labeled fixture volume remains for review and contains no key or valid signed transaction.
