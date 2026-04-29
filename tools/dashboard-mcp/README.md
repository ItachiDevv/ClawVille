# clawville-dashboard MCP

Local MCP server for mutating ClawVille's `dashboard_phases` table — what
backs the `/dash` → **Phases** tab on the internal dashboard.

The Q3 plan markdown (`.claude/plans/gamification-economy-and-shop-q3.md`)
stays authoritative for **design**; this table tracks **live ship status**.
The MCP is the operator CLI for keeping it in sync.

## Setup

1. Ensure `.env.local` at the repo root has `DATABASE_URL` set to the prod
   Supabase pooler URL. The MCP loads it from there.

2. `bun install` from `tools/dashboard-mcp/` to fetch the SDK.

3. Add to your Claude Code `~/.claude/mcp.json` (or `claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "clawville-dashboard": {
         "command": "bun",
         "args": [
           "C:/Users/newma/Documents/Crypto/ClawVille/tools/dashboard-mcp/server.ts"
         ]
       }
     }
   }
   ```

   (Adjust the absolute path for your machine.)

4. Restart Claude Code. Tools appear under the `clawville-dashboard`
   namespace.

## Tools

| Tool | Purpose |
|---|---|
| `list_phases` | Read all phases sorted by `sort_order` |
| `get_phase` | Look up one phase by slug |
| `create_phase` | Insert a new phase |
| `update_phase` | Mutate one phase by slug (status/notes/etc.) |
| `delete_phase` | Hard-delete (rare; usually update status to `paused`) |

Statuses: `planned` · `in_progress` · `shipped` · `blocked` · `paused`.

## Examples (Claude prompts)

> "List all dashboard phases."
> → calls `list_phases` → returns 7 rows

> "Mark phase-3-content as shipped with notes 'first 4 surfboards seeded; cosmetic-loader mounted in Reef Race scene'."
> → calls `update_phase({ slug: 'phase-3-content', status: 'shipped', notes: '...' })`

> "Add a new phase 'phase-7-localization' planned, sort order 8, description 'i18n surface for non-English Milady users'."
> → calls `create_phase({ slug: 'phase-7-localization', name: 'Localization', status: 'planned', sortOrder: 8, description: '...' })`

## Caveats

- Writes directly to **prod** Supabase. No preview environment.
- The `updated_at` timestamp refreshes on every `update_phase` call (server-set).
- `slug` must match `[a-z0-9][a-z0-9._-]{0,63}` and is the only stable
  identifier — never rename a slug; create a new one and update references
  if you must.
