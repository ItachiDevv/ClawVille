# Hosted skill runtime prompt probe

This release gate proves that a claimed building skill and the current connection
protocol manual reach the exact prompt sent to an agent model. It inspects the
outbound HTTP request rather than treating a database memory row as proof of
consumption.

The probe creates a temporary `building_skills` row with a unique canary. The
claim route accepts this arbitrary test building id because it resolves skills
only through `building_skills`; it does not require a map-location building. No
real building manual is replaced.

## Topology

The API process makes both outbound model calls. The probe and API must therefore
run on the same machine **and in the same network namespace**, with both processes
using the same non-production database:

```text
probe process -> local/staging API -> 127.0.0.1 probe mock
```

The primary release-gate mode is a locally built API plus its local or staging-only
development database. For a staging-box run, execute the probe inside the staging
API container/network namespace; running it on a workstation while `--api` points
at the remote staging API cannot work because that API's loopback is remote from
the workstation.

Lane A stores an ephemeral `http://127.0.0.1:<port>` URL in the disposable
agent's `customization.gateway.gatewayUrl`. The current declared-gateway provider
passes this URL to `fetch` without an SSRF or hostname-allowlist check, so the
loopback mock is accepted. Lane B uses the server-owned Hermes-local target on
`127.0.0.1:8642`. Port 8642 must be free before the run.

The probe refuses the production API hostname and the known production database
host. Never point `--api`, `DATABASE_URL`, or `ELIZA_DATABASE_URL` at production.

## Prerequisites

- Bun dependencies are installed for the worktree.
- `DATABASE_URL` points to the same local or staging-only database used by the API.
- If set, `ELIZA_DATABASE_URL` points to that same non-production database.
- The API process has `OPENAI_API_KEY` present because both skill installation and
  semantic retrieval require embeddings. The probe does not inspect the API
  process environment; the claim/readiness assertions fail closed if it is absent.
- The API is built from the branch under test. Do not use the development watcher.

From `apps/api`, build and start the API in one terminal:

```sh
bun run build
bun run start
```

The default local API base is `http://localhost:4000`.

## Run

From the repository root, in a second terminal:

```sh
bun run apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts --api http://localhost:4000
```

For an on-box staging run, from a checkout inside the staging API's network
namespace and with the staging-only database environment loaded:

```sh
bun run apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts --api https://api-staging.clawville.world
```

Do not run that staging command from a workstation.

The hard gate has two lanes:

1. **Declared-gateway wire:** claims the canary through the session-authenticated
   skill route, requires `installed: "runtime"`, then drives the founder chat path
   at `POST /api/avatars/me/chat`. The spawned OpenAI-compatible mock must receive
   a composed prompt containing the canary, a stable marker extracted from the
   current `buildProtocolManual` output, the imported current protocol version,
   and `[Current state context]`.
2. **Hermes-local wire:** replays that captured composed prompt through the real
   `AgentSubstrateClient.chatHermesLocal` path and the existing Hermes mock on
   port 8642. The forwarded request must contain the same evidence.

Each hard assertion prints a numbered pass line. Any hard-lane failure exits 1;
a successful gate ends with `ALL PASS`.

## Flags

- `--api <base>` selects the local or staging API base and is required.
- `--with-echo` adds an advisory Milady/OpenAI turn that asks for the canary. It
  consumes real model credits and is nondeterministic, so its result is reported
  but never changes the gate exit status.
- `--keep` retains the disposable database fixtures and their prompt memories for
  investigation. No credential, session value, key, token, secret, prompt, or
  model reply is printed. Without this flag, cleanup runs on success and ordinary
  failure paths.

By default, cleanup first requests and confirms runtime stop, then removes the
canary skill, disposable Lucia session, user, avatar, platform agent,
probe-attributed events, and ElizaOS prompt/knowledge rows. Mock servers spawned
by the probe are stopped as the command exits.

After a normal run, stop the local API process when it is no longer needed. With
`--keep`, the probe intentionally leaves database rows, prompt memories, and
in-memory runtime state inspectable while still stopping its mock servers. The
retained declared-gateway runtime points at a stopped ephemeral mock, so further
chat requires replacing that gateway or restarting/updating the local API. Stop
the API process when the investigation ends.
