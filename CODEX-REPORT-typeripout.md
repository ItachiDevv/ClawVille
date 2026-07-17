# Codex Report — Supported Identity-Type Ripout

Date: 2026-07-17
Branch: `fix/identity-type-ripout-2026-07-17`
Base: `origin/master` at `7011bd3c`

## Outcome

ClawVille now exposes exactly four public agent identity values:

- `milady`
- `hermes`
- `openclaw`
- `custom`, the general OpenAI-compatible gateway configuration

`hatcher` remains reserved for partner-signed registration. The public `/connect` and `/join` schemas do not accept it. The unsupported identity values `nanoclaw`, `anonymous`, and `ironclaw` were removed from public identity enums, the identity-adapter registry, identity-based routing/restoration branches, species fallback coverage, active manuals, integration fixtures, and smoke clients. The string `nanoclaw` survives only as the internal fail-soft pull wire protocol where that transport is still required.

Hosted-avatar identity is now stamped as `milady`. Its classification remains guarded by all three required facts: the bot `agentId` equals the owner's `avatar.platformAgentId`, the bot identity equals `HOSTED_AVATAR_IDENTITY_TYPE`, and the avatar harness is in the hosted set.

No migration was applied. No push occurred. No production write occurred.

## Production read-only classification

The production analysis was executed inside a read-only transaction (`BEGIN TRANSACTION READ ONLY` followed by `ROLLBACK`) before the migration was authored. The reproducible query is:

`packages/database/scripts/identity-type-ripout-analysis.sql`

| Legacy identity | Strict hosted-avatar rows | Non-hosted rows | Total rows |
|---|---:|---:|---:|
| `nanoclaw` | 10 | 31 | 41 |
| `anonymous` | 0 | 67 | 67 |
| `ironclaw` | 0 | 0 | 0 |

The founder's reported count of 28 bound `nanoclaw` rows is also correct when “bound” means `openclaw_bots.user_id IS NOT NULL`. It is not equivalent to the strict hosted-avatar classification. Of those 28 bound rows:

- 10 satisfy every hosted-avatar conjunct.
- 13 belong to Milady-harness avatars whose `platformAgentId` is null.
- 1 is a house Milady row whose avatar `platformAgentId` is null.
- 3 belong to OpenClaw-harness avatars whose bot `agentId` does not equal `platformAgentId`.
- 1 has no matching avatar.

Therefore, migration `0041` sends only the 10 strict hosted rows to `milady`. The other 18 bound-but-non-strict rows follow the directive for all remaining unsupported rows and are re-tagged `custom`.

## Migration authored, not applied

Migration file:

`packages/database/migrations/0041_identity_type_ripout.sql`

The first guarded update changes `nanoclaw` to `milady` only when all of these predicates hold:

- `b.identity_type = 'nanoclaw'`
- an avatar exists with `a.user_id = b.user_id`
- `a.platform_agent_id IS NOT NULL`
- `b.agent_id = a.platform_agent_id::text`
- `a.harness IN ('milady', 'hermes', 'openclaw')`

The second guarded update preserves every remaining legacy bot row by changing it to `custom` only when:

- `identity_type IN ('nanoclaw', 'anonymous', 'ironclaw')`

Both statements update `updated_at`. Neither statement deletes a row, changes ownership, changes a wallet, or mutates session material. Both are idempotent: after one successful application, neither legacy-value predicate matches on a re-run.

The operator, not this worktree, applies the migration.

## Routing and restoration model

Routing remains discriminated by `protocolKind`, which represents where cognition runs. The surviving `IDENTITY_ADAPTERS` entries are only:

- `hatcher`: partner proxy
- `milady`: ClawVille-hosted ElizaOS/Milady cognition
- `hermes`: self-managed pull, with the optional Hermes-local runtime gate
- `openclaw`: declared BYO gateway, or OpenClaw-local only when gateway-less and enabled
- `custom`: declared gateway for every other agent

The request's current gateway fact is authoritative. A declared gateway is persisted and used for gateway-posting cognition. A validated request without a gateway clears any stale row gateway. This prevents a relabeled Milady or Hermes row, or hosted OpenClaw row, from retaining an obsolete BYO-routing fact.

Ticket/account identity derivation now reuses the already validated identity label. Inferred or explicit `custom` no longer creates an OpenClaw-keyed identity fingerprint. OpenClaw restoration and `/session-status` use the same persisted gateway fact: declared-gateway OpenClaw cannot restore without its unpersisted credential, while gateway-less OpenClaw restores only through the enabled local runtime.

`/connect` owns runtime-signal and gateway validation. `/join` shares only the four-value public identity enum; it permits Milady identity bootstrap without `miladyAgentId` and has no gateway fields.

## Hosted-avatar migration

`HOSTED_AVATAR_IDENTITY_TYPE` changed from `nanoclaw` to `milady`. New hosted-avatar signups, internal hosted-avatar sessions, house-agent rows, classification tests, and hosted status fixtures use the supported `milady` identity. The internal tool-surface wire may still be `nanoclaw`; that wire is not an identity label and performs no outbound cognition request.

## Protocol version and partner boundary

`PROTOCOL_VERSION` changed from 22 to 23 because removing values from the public `/connect` and `/join` identity enums is an agent-visible contract change.

Version 23 was propagated through:

- `buildProtocolManual` and the play manual in `apps/api/src/services/skill-protocol.ts`
- Nori knowledge in `packages/agent-templates/src/locations/town-guide.ts`
- orientation knowledge in `packages/shared/src/constants/orientation-skill.ts`
- generated building-skill source copy in `scripts/generate-building-skills.ts`
- the public connect manual in `apps/api/src/routes/agent-gateway.ts`
- the partner integration specification in `docs/hatcher-integration-spec.md`
- active protocol-version test pins

The Hatcher partner contract remains frozen apart from the expected pointer version and derived content hash. The pointer shape remains exactly `{ version, contentHash, url }`. Register, PATCH, stats, unauthorized-response, DELETE, signed paths, cognition callback bodies, and the six `[ACTION:]` verbs and their parameters/bounds are unchanged.

The partner cross-check used Hatcher host-frontend HEAD:

`9cc426b608bd66d0f40cd9f72beb95574f221712`

Protected code review found only comment changes in `partner-hatcher.ts`, `require-auth-or-agent.ts`, and `skills.ts`; `npc-simulation.ts` has no diff. Hatcher proxy routing, restorability, reserved species behavior, action capability, and proximity exemption remain test-pinned.

## Hermes integration

The in-repository Hermes client now sends a supported request shape:

- a stable public `agentId`
- `identityType: 'hermes'`
- the internal self-managed pull wire `protocol: 'nanoclaw'`

The default install ID is a one-time 128-bit random value persisted in a mode-`0600` install file with exclusive creation, flush, and fsync. Existing saved state has first precedence, followed by the explicit `CLAWVILLE_AGENT_ID` override. This avoids globally colliding IDs across machines with the same home-directory path.

## Verification

### Workspace build

Command:

`bunx turbo run build --filter=@clawville/shared --filter=@clawville/database --filter=@clawville/agent-runtime --filter=@clawville/wager-program`

- 5/5 tasks succeeded
- Duration: 6.813 seconds

### TypeScript

- `bunx tsc --noEmit -p apps/api/tsconfig.json`: exit 0
- `bunx tsc --noEmit -p packages/shared/tsconfig.json`: exit 0
- `bunx tsc --noEmit -p packages/database/tsconfig.json`: exit 0

### Touched service and route suites

- 180 passed
- 0 failed
- 668 expectations
- 13 files

This set covers session configuration, hosted classification, reconnect planning, restoration, hosted-avatar session behavior, reserved namespaces, protocol onboarding, paid-agent protocol exposure, dashboard acknowledgement posture, handback behavior, and the onboarding smoke unit surfaces.

The 13 files were:

- `apps/api/src/services/__tests__/agent-session-config.test.ts`
- `apps/api/src/services/__tests__/agent-session-config-hermes.test.ts`
- `apps/api/src/services/__tests__/agent-session-config-openclaw.test.ts`
- `apps/api/src/services/__tests__/agent-session-classify.test.ts`
- `apps/api/src/services/__tests__/agent-reconnect-session.test.ts`
- `apps/api/src/services/__tests__/agent-session-restore-attribution.test.ts`
- `apps/api/src/services/__tests__/hosted-avatar-agent-session.test.ts`
- `apps/api/src/services/__tests__/hosted-gateway-prewarm.test.ts`
- `apps/api/src/services/__tests__/reserved-agent-namespaces.test.ts`
- `apps/api/src/services/__tests__/agent-control-handback.test.ts`
- `apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts`
- `apps/api/src/routes/__tests__/dashboard-skill-acks.test.ts`
- `apps/api/src/routes/__tests__/agent-paid-surface.test.ts`

### Hermes install-ID unit test

Command:

`python -m unittest integrations/hermes/scripts/test_clawville_install_id.py`

- 3 passed
- 0 failed

The tests prove same-install stability and private mode, distinct IDs for two fresh installs, and existing-state/environment precedence.

### Mock-Hatcher self-test

Command:

`bun run apps/api/scripts/hatcher/selftest-e2e.ts`

- 86 PASS
- 0 FAIL
- 0 SKIP
- `HARNESS EXIT: 0`

The localhost database-failure branches observed by the self-test are expected negative-path assertions; they are not harness failures.

### Static review

- `git diff --check`: clean
- no unsupported identity remains in a public identity enum or identity adapter
- remaining `nanoclaw` matches on active paths are internal wire-protocol uses
- no Hatcher behavior change was found

## Complete file inventory

### Environment and canonical documentation

- `.env.example`
- `ARCHITECTURE.md`
- `GameFeatures.md`
- `TODO.md`
- `docs/eliza-integration-architecture.md`
- `docs/hatcher-integration-spec.md`
- `docs/milady-integration-plan.md`

### Public contracts, manuals, and shared types

- `apps/api/src/services/skill-protocol.ts`
- `apps/api/src/routes/agent-gateway.ts`
- `packages/shared/src/constants/orientation-skill.ts`
- `packages/shared/src/types/agent-substrate.ts`
- `packages/agent-templates/src/locations/town-guide.ts`
- `scripts/generate-building-skills.ts`

### Authentication, routing, classification, and hosted sessions

- `apps/api/src/middleware/require-auth-or-agent.ts`
- `apps/api/src/routes/avatars.ts`
- `apps/api/src/routes/partner-hatcher.ts`
- `apps/api/src/routes/skills.ts`
- `apps/api/src/services/agent-autonomy-reconcile.ts`
- `apps/api/src/services/agent-reconnect-session.ts`
- `apps/api/src/services/agent-session-classify.ts`
- `apps/api/src/services/agent-session-config.ts`
- `apps/api/src/services/agent-session-restore.ts`
- `apps/api/src/services/agent-substrate-client.ts`
- `apps/api/src/services/hosted-avatar-agent-session-plan.ts`
- `apps/api/src/services/hosted-avatar-agent-session.ts`
- `apps/api/src/services/house-agent-seeder.ts`

### Database migration, analysis, and schema copy

- `packages/database/migrations/0041_identity_type_ripout.sql`
- `packages/database/scripts/identity-type-ripout-analysis.sql`
- `packages/database/migrations-manual/2026-07-08_add_openclaw_autonomy_enrolled.sql`
- `packages/database/src/schema/claws.ts`
- `packages/database/src/schema/wallets.ts`

### Integration and smoke tooling

- `apps/api/scripts/agent-connect/hermes-e2e.ts`
- `apps/api/scripts/agent-connect/openclaw-e2e.ts`
- `apps/api/scripts/agent-onboarding-smoke.ts`
- `apps/api/scripts/poker/mock-tm-backend.ts`
- `apps/api/scripts/poker/multi-agent-stress.ts`
- `integrations/hermes/scripts/clawville.py`
- `integrations/hermes/scripts/test_clawville_install_id.py`
- `scripts/hermes-test-client.py` (added)
- `scripts/nanoclaw-test-client.py` (removed)

### Tests and fixtures

- `apps/api/src/routes/__tests__/agent-paid-surface.test.ts`
- `apps/api/src/routes/__tests__/dashboard-skill-acks.test.ts`
- `apps/api/src/services/__tests__/agent-control-handback.test.ts`
- `apps/api/src/services/__tests__/agent-reconnect-session.test.ts`
- `apps/api/src/services/__tests__/agent-session-classify.test.ts`
- `apps/api/src/services/__tests__/agent-session-config-hermes.test.ts`
- `apps/api/src/services/__tests__/agent-session-config-openclaw.test.ts`
- `apps/api/src/services/__tests__/agent-session-config.test.ts`
- `apps/api/src/services/__tests__/hosted-avatar-agent-session.test.ts`
- `apps/api/src/services/__tests__/hosted-gateway-prewarm.test.ts`
- `apps/api/src/services/__tests__/reserved-agent-namespaces.test.ts`
- `apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts`

### Other stale-copy cleanup

- `apps/web/src/app/create-agent/personality/page.tsx`

### Report

- `CODEX-REPORT-typeripout.md`

The operator-owned untracked launcher `codex-typeripout.cmd` is explicitly excluded from the implementation commit.

## Open questions and operator decisions

1. The 18 bound-but-non-strict legacy rows do not satisfy the founder-mandated hosted classifier. Migration `0041` therefore changes them to `custom`. The operator should decide whether any of the 13 null-platform-ID Milady avatars, the house row, the three mismatched OpenClaw avatars, or the avatar-less row need a separate platform-agent repair after reviewing their ownership and runtime state.
2. Migration `0041` re-tags bot rows only. It does not rewrite `users.identity_fingerprint`, which was derived from `sha256(oldType:key)`. A legacy row later presenting the old bootstrap key under `custom` may resolve a different user. Signed ed25519 reconnect is separate and remains available where its secret exists. The operator should decide whether legacy fingerprint continuity needs a separately designed, credential-aware migration; it is intentionally outside `0041`.
3. The operator still needs to run the live staging Hatcher harness, staging onboarding smoke, and a staging database migration dry-run before promotion.
4. The operator should review the 18-row exception set before applying `0041`; the migration itself must not be broadened without a new explicit decision.

## Local commit

Planned single local commit subject:

`fix: rip out unsupported identity types`

The exact commit hash is recorded by Git only after this report is included in that commit. No push is authorized or planned.

RIPOUT-DONE
