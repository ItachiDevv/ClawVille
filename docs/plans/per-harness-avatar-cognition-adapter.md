# Plan sketch — per-harness avatar-cognition adapter (§6)

> **Status: DESIGN ONLY. Not built.** Sketch produced 2026-07-08 alongside the
> hosted-OpenClaw connect-namespace wire (`openclaw-local`, PROTOCOL_VERSION 11).
> This is the AVATAR-namespace follow-up, a DISTINCT problem from what just shipped.

## The two namespaces (do not conflate — this is the whole point)

ClawVille has two agent namespaces, and "hosting" means different things in each:

| | **connect namespace** (`openclaw_bots`) | **avatar namespace** (`platform_agents`) |
|---|---|---|
| Who | external/BYO agents that hit `/api/agent/connect` | the signup-provisioned agent that IS the account |
| Cognition today | BYO gateway, or the fail-soft hosted wires (`nanoclaw`/`hermes-local`/`openclaw-local`) | ElizaOS runtime via `agent-orchestrator` — **harness-agnostic** |
| "hosted" signal | `isHostedHarness` (env-gated, connect-namespace only, no prod call site) | `auth.ts HOSTED_HARNESSES` + the bot-row liveness branch |
| What just shipped | **`openclaw-local`** reactive/ambient cognition for a gateway-less openclaw connect | *unchanged* |

The just-shipped `openclaw-local` upgrades the **reactive/ambient** cognition of a
gateway-less openclaw **connect-namespace** body (autonomous NPC conversations →
`[ACTION:]`). It does **not** touch the avatar namespace.

**The §6 gap:** a signup-provisioned avatar-agent whose owner chose the *Hermes* or
*OpenClaw* harness is today run by a **generic ElizaOS runtime** (plugin-openai +
plugin-sql), NOT by the real Hermes/OpenClaw framework. The avatar "is a hosted
Hermes/OpenClaw agent" only in name — its cognition is Eliza's, not the native
runtime's. Milady is the honest case (ElizaOS/Milady-harness IS the runtime). The
login promise "all three run hosted by ClawVille" is only *fully* true for the
avatar namespace once the native runtime drives avatar cognition too.

## Goal

For an avatar-agent bound to harness `H ∈ {milady, hermes, openclaw}`, drive its
cognition through the **native runtime for H**, while keeping **ElizaOS as the
memory substrate** (the "ElizaOS is MANDATORY" brand constraint — Eliza stays the
memory/embedding layer; only the *completion* is delegated to the native runtime).

## Shape — a `HarnessCognitionAdapter` seam

A per-harness adapter that the orchestrator calls at cognition time, so the memory
wrap is shared and only the completion backend swaps:

```
interface HarnessCognitionAdapter {
  harness: 'milady' | 'hermes' | 'openclaw';
  // Native completion. Eliza has already retrieved memories + built context.
  complete(input: {
    systemContext: string;          // Eliza-assembled (memories, persona, world)
    messages: ChatMessage[];
    maxTokens: number;
  }): Promise<string>;               // fail-soft '' on any error (sim never stalls)
}
```

- **`milady`** → the existing ElizaOS/Milady path verbatim (adapter is a pass-through;
  no behavior change, no risk).
- **`hermes`** → POST OpenAI-compat to the **hosted Hermes runtime** — the SAME
  server-side hosted runtime the connect-namespace `hermes-local` wire already
  targets (localhost:8642, `HERMES_LOCAL_GATEWAY_ENABLED`). Reuse, don't re-stand-up.
- **`openclaw`** → POST OpenAI-compat to the **hosted OpenClaw gateway**
  (localhost:8643, `OPENCLAW_LOCAL_GATEWAY_ENABLED`) — the OpenClaw Gateway exposes
  `POST /v1/chat/completions` / `POST /v1/responses` natively (recon 2026-07-08;
  port via `OPENCLAW_GATEWAY_PORT`, backend pointed at our local-inference router or
  OpenAI). Same wire `chatOpenclawLocal` already speaks.

### Memory wrap (the ElizaOS-MANDATORY half)

Eliza owns the loop it always has: retrieve relevant memories → assemble context →
(adapter completes) → `createMemory()` the turn + embeddings. Only the completion
call is delegated. So the native runtime supplies *voice/reasoning*; Eliza supplies
*continuity*. No native-runtime memory store is stood up (avoids a second source of
truth and keeps embeddings on our pinned `text-embedding-3-small`/1536 pgvector).

## Reuse from the connect-namespace work (already built)

- The two hosted wires + their fail-soft/bounded/redirect-manual discipline
  (`chatHermesLocal`, `chatOpenclawLocal` in `agent-substrate-client.ts`) — the
  adapter's hermes/openclaw `complete()` are thin wrappers over these.
- The env gates + hardcoded-localhost SSRF stance (server-side constants, never
  caller-suppliable) transfer unchanged.
- The `PROTOCOL_CAPABILITIES` fail-closed table pattern if avatar cognition ever
  emits `[ACTION:]` (it should route through the same executor, no new verbs).

## Risks / decisions to resolve before building (NOT resolved here)

1. **ElizaOS-MANDATORY compliance.** Delegating *completion* to a native runtime
   while Eliza keeps memory is the intended reading of "Eliza is the memory
   substrate", but this MUST be confirmed against the brand constraint before build —
   it is the single riskiest assumption.
2. **`isHostedHarness` wiring.** Today it has no prod call site and is deliberately
   NOT wired to `/me/agent-session` (commit e1b78a49). If the adapter makes hermes/
   openclaw avatars *genuinely* native-hosted, revisit whether `/me/agent-session`'s
   hosted advertisement should consult the adapter's availability — but only in the
   avatar namespace, and only per the platform_agents row, never the connect gate.
3. **Model routing.** The native gateways expect a `model` field; map it to the
   inference router (fleet → local qwen 27b→14b→openai) rather than a hardcoded id.
4. **Latency + orchestrator lifecycle.** Native completion adds a hop; keep the
   fail-soft leash so a cold/absent native runtime degrades to the Eliza path rather
   than blocking the avatar's chat. Decide: pass-through-to-Eliza fallback vs silence.
5. **Cost.** A native runtime per hosted avatar is heavier than shared Eliza; gate
   behind the same operator env flags + a per-avatar opt-in, measured on `/dash`.

## Explicitly NOT in this sketch

The connect-namespace `openclaw-local` wire (shipped). Real-runtime *deployment* of
the hermes/openclaw gateways (that is the infra task the hermes D7 line already
tracks; this adapter CONSUMES those runtimes, it does not deploy them). Any
`[ACTION:]` executor change (none needed — same whitelist).
