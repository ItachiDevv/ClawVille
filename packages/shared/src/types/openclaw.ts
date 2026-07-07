/**
 * @deprecated Neutral-substrate rename (P3 slice 5, 2026-07-05). The agent-bot
 * substrate types moved to `./agent-substrate`. This re-export shim keeps any
 * lingering `types/openclaw` import path resolving at compile time. Prefer
 * importing from `@clawville/shared` (or `./agent-substrate` directly).
 *
 * NOTE: this is the SUBSTRATE rename only. The HARNESS name "openclaw" is
 * unchanged — `AgentIdentityType`'s `'openclaw'` value, the `/api/openclaw/*`
 * routes, the `openclaw:<id>` model prefix, and `format:'openclaw'` all stay.
 */
export * from './agent-substrate';
