/**
 * AgentConnectModal — forward shim.
 *
 * The concurrent /create-agent rewrite (now in a worktree) renamed
 * `OpenClawConnectModal` → `AgentConnectModal` in consumer imports
 * (`game/page.tsx:22`) but the renamed component file lives in the
 * worktree, not master. Until that lands, this shim re-exports the
 * existing implementation so master builds.
 *
 * Delete after the worktree merges and the real `agent-connect-modal`
 * implementation arrives (or flip the direction: make this the real
 * file and the `openclaw-connect-modal.tsx` a deprecation shim).
 */
export { default } from './openclaw-connect-modal';
