# vendor/npm — vendored registry tarballs

Tarballs for npm packages that disappeared from the registry but are still
required by the dependency tree. Wired in via the root `package.json`
`overrides` field (`file:./vendor/npm/<tarball>`); both app Dockerfiles COPY
`vendor/` before `bun install`.

## bonfida-spl-name-service-3.0.23.tgz (added 2026-08-03)

`@bonfida/spl-name-service` vanished ENTIRELY from registry.npmjs.org on
2026-08-03 (packument 404, zero versions) — it is a hard dependency of
`@oobe-protocol-labs/synapse-sap-sdk@1.0.0` (`^3.0.23`, no SDK version without
it), so every fresh `bun install` (= every Coolify image build, staging AND
prod) failed with a download 404.

Provenance + safety checks performed before vendoring:
- Tarball fetched from the npmmirror registry cache; its sha512 is
  **byte-identical** to the integrity hash `bun.lock` had pinned for weeks
  (`sha512-RXx4vkIHwU8LJPPFVHcntY0c5l3DNZZZujuD7XnkMScNAO9Pykp4EwQxmDLC9o07uRupoya0WB2uY1LDHJHNFw==`)
  — i.e. the exact bytes already running on prod; vendoring introduces no new
  supply-chain exposure.
- Manual scan: no install/postinstall hooks, no child_process/eval/network
  patterns in dist, normal file inventory, MIT license.
- No security advisory naming this package was found at vendor time; the
  removal reason is unknown (npm support ticket territory). If an advisory
  later flags 3.0.2x as compromised, REMOVE this tarball and drop/replace the
  SAP SDK dependency instead — do not keep shipping it.

Exit condition: when the package reappears on npm (or the SAP SDK drops the
dependency), delete the tarball + the override in the same diff.
