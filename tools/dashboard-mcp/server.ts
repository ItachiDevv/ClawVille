/**
 * ClawVille dashboard-phases MCP server.
 *
 * Local-only stdio MCP server. Lets Claude Code (or any MCP-compatible
 * agent) inspect + mutate the `dashboard_phases` table that backs the
 * /dash → "Phases" tab. The plan markdown stays authoritative for DESIGN;
 * this table tracks live SHIP STATUS, and the MCP is the operator's CLI
 * for keeping it in sync.
 *
 * Tools exposed:
 *   list_phases()                 — read all phases sorted by sort_order
 *   get_phase(slug)               — read one phase by slug
 *   create_phase({ slug, name, description?, status?, notes?, sortOrder? })
 *   update_phase({ slug, status?, notes?, name?, description?, sortOrder? })
 *   delete_phase(slug)            — hard delete (rare; usually update status)
 *
 * Usage (Claude Code):
 *   1. Ensure repo .env.local has DATABASE_URL set (production Supabase URL).
 *   2. Add to your `~/.claude/mcp.json` (or equivalent):
 *      {
 *        "mcpServers": {
 *          "clawville-dashboard": {
 *            "command": "bun",
 *            "args": ["<repo>/tools/dashboard-mcp/server.ts"]
 *          }
 *        }
 *      }
 *   3. Restart Claude Code; tools appear under the `clawville-dashboard`
 *      namespace.
 *
 * NOTE: This writes directly to the prod DB (Supabase). There is no preview
 * environment. Treat phase updates as live changes — they appear on the
 * dashboard immediately.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import postgres from 'postgres';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Walk up to find repo root .env.local.
config({ path: resolve(__dirname, '../../.env.local') });

if (!process.env.DATABASE_URL) {
  // MCP servers can't print to stdout (it's the JSON-RPC channel) — write
  // diagnostics to stderr.
  console.error('[dashboard-mcp] DATABASE_URL not set; check ../../.env.local');
  process.exit(1);
}

// prepare:false — Supabase transaction pooler (:6543) requires it (see packages/database/src/index.ts).
const db = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });

const VALID_STATUSES = ['planned', 'in_progress', 'shipped', 'blocked', 'paused'] as const;

const slugRe = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const ListSchema = z.object({}).strict();
const GetSchema = z.object({ slug: z.string().regex(slugRe) }).strict();
const CreateSchema = z.object({
  slug: z.string().regex(slugRe),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  status: z.enum(VALID_STATUSES).default('planned'),
  notes: z.string().max(4000).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
}).strict();
const UpdateSchema = z.object({
  slug: z.string().regex(slugRe),
  status: z.enum(VALID_STATUSES).optional(),
  notes: z.string().max(4000).nullable().optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
}).strict();
const DeleteSchema = z.object({ slug: z.string().regex(slugRe) }).strict();

const server = new Server(
  { name: 'clawville-dashboard', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_phases',
      description:
        'Return all phases from dashboard_phases sorted by sort_order. No arguments.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'get_phase',
      description: 'Look up one phase by slug. Returns null if not found.',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'phase slug, e.g. "phase-3-engine"' } },
        required: ['slug'],
        additionalProperties: false,
      },
    },
    {
      name: 'create_phase',
      description:
        'Insert a new phase. status defaults to "planned". sortOrder appended to end if omitted. Slug must be unique.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: VALID_STATUSES as readonly string[] as string[] },
          notes: { type: 'string' },
          sortOrder: { type: 'integer', minimum: 0 },
        },
        required: ['slug', 'name'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_phase',
      description:
        'Mutate one phase by slug. Any field-named arg replaces; pass null on `notes`/`description` to clear. updated_at refreshes automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          status: { type: 'string', enum: VALID_STATUSES as readonly string[] as string[] },
          notes: { type: ['string', 'null'] },
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          sortOrder: { type: 'integer', minimum: 0 },
        },
        required: ['slug'],
        additionalProperties: false,
      },
    },
    {
      name: 'delete_phase',
      description:
        'Hard-delete one phase by slug. Use sparingly; usually `update_phase` to "paused" or "shipped" is the right move.',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case 'list_phases': {
        ListSchema.parse(args ?? {});
        const rows = await db`
          SELECT slug, name, description, status, notes, sort_order, created_at, updated_at
          FROM dashboard_phases ORDER BY sort_order
        `;
        return ok({ phases: rows });
      }
      case 'get_phase': {
        const { slug } = GetSchema.parse(args);
        const rows = await db`
          SELECT slug, name, description, status, notes, sort_order, created_at, updated_at
          FROM dashboard_phases WHERE slug = ${slug} LIMIT 1
        `;
        return ok({ phase: rows[0] ?? null });
      }
      case 'create_phase': {
        const v = CreateSchema.parse(args);
        // If sortOrder not provided, append to end.
        const order = v.sortOrder ?? (await nextSortOrder());
        const rows = await db`
          INSERT INTO dashboard_phases (slug, name, description, status, notes, sort_order)
          VALUES (${v.slug}, ${v.name}, ${v.description ?? null}, ${v.status}, ${v.notes ?? null}, ${order})
          RETURNING slug, name, status, sort_order
        `;
        return ok({ created: rows[0] });
      }
      case 'update_phase': {
        const v = UpdateSchema.parse(args);
        // Build dynamic SET — postgres.js helper merges undefined fields out.
        const updates: Record<string, unknown> = { updated_at: new Date() };
        if (v.status      !== undefined) updates.status = v.status;
        if (v.notes       !== undefined) updates.notes = v.notes;
        if (v.name        !== undefined) updates.name = v.name;
        if (v.description !== undefined) updates.description = v.description;
        if (v.sortOrder   !== undefined) updates.sort_order = v.sortOrder;

        if (Object.keys(updates).length === 1) {
          return err(`No update fields supplied for slug "${v.slug}".`);
        }
        const rows = await db`
          UPDATE dashboard_phases SET ${db(updates)}
          WHERE slug = ${v.slug}
          RETURNING slug, status, notes, sort_order, updated_at
        `;
        if (rows.length === 0) return err(`No phase with slug "${v.slug}".`);
        return ok({ updated: rows[0] });
      }
      case 'delete_phase': {
        const { slug } = DeleteSchema.parse(args);
        const rows = await db`DELETE FROM dashboard_phases WHERE slug = ${slug} RETURNING slug`;
        if (rows.length === 0) return err(`No phase with slug "${slug}".`);
        return ok({ deleted: rows[0].slug });
      }
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof z.ZodError) {
      return err(`Invalid arguments: ${e.errors.map((x) => x.message).join('; ')}`);
    }
    return err(`Internal error: ${(e as Error).message}`);
  }
});

async function nextSortOrder(): Promise<number> {
  const rows = await db<[{ max: number | null }]>`SELECT MAX(sort_order) AS max FROM dashboard_phases`;
  return (rows[0].max ?? -1) + 1;
}

function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    isError: false,
  };
}
function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[dashboard-mcp] connected; waiting for tool calls on stdio');

// Cleanup on disconnect
process.on('SIGINT', async () => {
  await db.end();
  process.exit(0);
});
