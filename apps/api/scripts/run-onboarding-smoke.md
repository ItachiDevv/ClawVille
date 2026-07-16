# Terminal-agent onboarding smoke

This is the sibling regression gate for the public, non-partner onboarding path.
It follows the code-generated `clawville-play` manual with a new disposable
agent identity, then verifies binding, movement, learning surfaces, protocol
access, and a returning connect. It does not exercise or replace the signed
Hatcher harness.

## Prerequisites

- The API and its database are running with the branch under test.
- Empty staging/dev databases have the ten building manuals seeded once:

  ```sh
  bun run scripts/seed-building-skills-fixture.ts
  ```

- For local verification, build and start the API from `apps/api` with the
  normal `.env.local` database configuration:

  ```sh
  bun run build
  bun run start
  ```

## Run

From `apps/api`:

```sh
bun run scripts/agent-onboarding-smoke.ts --api http://localhost:4000
```

Against staging after deployment:

```sh
bun run scripts/agent-onboarding-smoke.ts --api https://api-staging.clawville.world
```

The command emits one `PASS` or `FAIL` line per check and exits non-zero on the
first failure. It never prints the generated `identityKey`, session bearer,
one-time identity secret, wallet secret, or response bodies. Each run creates a
fresh, uniquely named smoke agent/user row; there is no production target in
the documented workflow and no automatic destructive cleanup.
