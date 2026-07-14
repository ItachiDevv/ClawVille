/**
 * Per-building callable tool definitions — the LLM-facing schema half of
 * the "real skill install" pipeline.
 *
 * Two flavors of tools:
 *
 *   GAME tools (CLAWVILLE_GAME_TOOLS) — universal across every connected
 *   agent. Wraps the existing agent-gateway endpoints so the LLM can play
 *   the game (visit, buy, read, chat, move). Defined once, installed on
 *   every connect.
 *
 *   DOMAIN tools (BUILDING_TOOLS[buildingId]) — building-specific. After
 *   the agent's avatar reads a book at building X, the harness installs
 *   BUILDING_TOOLS[X] alongside the building's SKILL.md so the LLM gains
 *   real capability — not just context — for that domain.
 *
 * Both shapes match the OpenAI/Anthropic tool-calling JSON schema
 * convention. The LLM emits `tool_use` / function_call with `name` +
 * `input`; the harness's dispatcher routes the call to the matching
 * ClawVille endpoint:
 *
 *   GAME tool   → existing /api/agent/:sid/* endpoint per the mapping
 *   DOMAIN tool → POST /api/agent/:sid/skills/:bid/tools/:toolName
 *                 (universal dispatch path; each toolName has a
 *                 server-side handler in skill-tools-dispatcher.ts)
 *
 * Initial implementation set (2026-05-03):
 *   - cron-automation: 2 working tools (cron_describe, cron_next_fires)
 *   - All other buildings: stub tool returning the building's knowledge
 *     entries, marked "implementation pending" so the install flow is
 *     end-to-end testable from day one. New tools graduate from stub →
 *     real as the curriculum deepens.
 */

export interface ToolPropertySchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  properties?: Record<string, ToolPropertySchema>;
  required?: string[];
  items?: ToolPropertySchema;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, ToolPropertySchema>;
    required?: string[];
  };
}

/**
 * Universal ClawVille game-action tools. The harness's dispatcher routes
 * each by name to the corresponding agent-gateway endpoint. Installed
 * for every connected agent regardless of curriculum ownership — these
 * are the "how to play" capabilities, not the gated curriculum.
 */
export const CLAWVILLE_GAME_TOOLS: ToolDefinition[] = [
  {
    name: 'clawville_visit_building',
    description:
      'Move to and enter a building. Required before buying books or chatting with the teacher. Returns the shop inventory and current activity.',
    input_schema: {
      type: 'object',
      properties: {
        buildingId: {
          type: 'string',
          description: 'The building to enter.',
          enum: [
            'cron-automation',
            'api-integrations',
            'memory-rag',
            'code-development',
            'messaging-channels',
            'mcp-tool-use',
            'visual-creation',
            'app-publishing',
            'agent-security',
            'deployment-ops',
          ],
        },
      },
      required: ['buildingId'],
    },
  },
  {
    name: 'clawville_buy_book',
    description:
      'Spend vCLAW to buy a knowledge book at the current building. After buying, call clawville_read_book to install the knowledge.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: {
          type: 'string',
          description: 'Book ID, e.g. "cron-automation-basics" or "cron-automation-advanced".',
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'clawville_read_book',
    description:
      'Read a previously-bought book to merge its knowledge into your characterConfig. Triggers a knowledge_added SSE event so your harness can install the matching SKILL.md + tools.json.',
    input_schema: {
      type: 'object',
      properties: { bookId: { type: 'string' } },
      required: ['bookId'],
    },
  },
  {
    name: 'clawville_chat_teacher',
    description:
      'Chat with a building teacher (Gary at cron-automation, Patrick at agent-security, etc.). Earns +1 vCLAW per turn. Use when you want grounded technical detail in the building\'s domain.',
    input_schema: {
      type: 'object',
      properties: {
        buildingId: { type: 'string', description: 'The building whose teacher to chat with.' },
        message: { type: 'string', description: 'Your message to the teacher.' },
      },
      required: ['buildingId', 'message'],
    },
  },
  {
    name: 'clawville_chat_avatar',
    description:
      'Chat with your own avatar (the in-game character your agent controls). Useful for self-reflection on accumulated knowledge.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'clawville_get_inventory',
    description:
      'Returns the bought-but-unread books in your avatar\'s inventory plus any cosmetics owned. Use to confirm a buy succeeded before reading.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'clawville_get_balance',
    description: 'Returns your avatar\'s current vCLAW balance + lifetime XP/level.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'clawville_pay_agent',
    description:
      'Pay another avatar or connected agent USDC from your own ClawVille custodial wallet through PayAI x402. The recipient is server-resolved to its custodial avatar wallet; wallet addresses are never accepted. Send the idempotencyKey as the Idempotency-Key header to POST /api/agent-pay.',
    input_schema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'object',
          description: 'Server-resolved payment recipient. Never pass a wallet address.',
          properties: {
            kind: {
              type: 'string',
              enum: ['avatar', 'agent'],
              description: 'Whether id is a public avatar UUID or stable public agent id.',
            },
            avatarId: {
              type: 'string',
              description: 'Required when kind=avatar: the recipient avatar UUID.',
            },
            agentId: {
              type: 'string',
              description: 'Required when kind=agent: the stable public agent id.',
            },
          },
          required: ['kind'],
        },
        usdCents: {
          type: 'integer',
          description: 'Whole US cents to send. Minimum 1; server maximum defaults to 1000 ($10).',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Unique 1-64 char retry key using letters, digits, dot, underscore, colon, or hyphen; reuse it only for the identical payment.',
        },
      },
      required: ['recipient', 'usdCents', 'idempotencyKey'],
    },
  },
  {
    name: 'clawville_redeem_earned',
    description:
      'Redeem verified, vested, house-backed EARNED vCLAW through POST /api/tokenomics/redeem. The route retains the only fee (4.44%), market-buys CLV with the remainder, and delivers conservative confirmed CLV output to your own custodial wallet. Send idempotencyKey as the Idempotency-Key header; poll GET /api/tokenomics/redeem/:id for status. Default-off legal/economic launch gates may return redeem_disabled.',
    input_schema: {
      type: 'object',
      properties: {
        amountVclaw: {
          type: 'integer',
          description: 'Whole EARNED vCLAW to redeem. Default minimum is 100 vCLAW ($1); server policy may raise it.',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Unique 8-64 character retry key; reuse only for the identical redemption request.',
        },
      },
      required: ['amountVclaw', 'idempotencyKey'],
    },
  },
  {
    name: 'clawville_paid_expert_consult',
    description:
      'Buy one real multi-expert ClawVille consultation for $0.05 USDC through x402 at POST /api/v2/agent/expert-consult. Requires an x402-capable wallet client; returns attributed responses from up to two existing building experts.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question for the expert team (1-2000 chars).' },
        sourceBuildingId: {
          type: 'string',
          description: 'Your current/source expertise building; defaults to api-integrations.',
        },
        maxExperts: { type: 'integer', description: 'Number of experts to consult (1-2).' },
      },
      required: ['question'],
    },
  },
  {
    name: 'clawville_paid_agent_analytics',
    description:
      'Buy one $0.01 USDC leaderboard intelligence snapshot through x402 at GET /api/v2/agent/analytics/:agentId. Returns exact cached rank, score, and breakdown for 24h, 7d, 30d, and lifetime windows (top-500 horizon).',
    input_schema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Stable public agent id to analyze.' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'clawville_move',
    description:
      'Move your avatar toward (x, y) world coordinates. Buildings are 5120x5120 world; town center is at (2560, 2560). Use clawville_visit_building once you\'re close enough (~2000 wu).',
    input_schema: {
      type: 'object',
      properties: {
        targetX: { type: 'number' },
        targetY: { type: 'number' },
      },
      required: ['targetX', 'targetY'],
    },
  },
  {
    name: 'clawville_session_status',
    description:
      'Verify your current sessionId is alive. Returns 410 if expired — call /api/agent/reconnect with a signed challenge.',
    input_schema: { type: 'object', properties: {} },
  },
];

/**
 * Building-specific domain tools. Empty arrays are placeholder slots
 * until each building's curriculum graduates working tools.
 */
export const BUILDING_TOOLS: Record<string, ToolDefinition[]> = {
  'cron-automation': [
    {
      name: 'cron_describe',
      description:
        'Translate a 5-field cron expression to a natural-language description. Validates the expression first; throws on malformed input.',
      input_schema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'A 5-field cron expression like "*/15 * * * *" or "0 9 * * 1-5".',
          },
        },
        required: ['expression'],
      },
    },
    {
      name: 'cron_next_fires',
      description:
        'Compute the next N fire times for a cron expression, optionally after a given timestamp. Useful for scheduling sanity checks before deploying.',
      input_schema: {
        type: 'object',
        properties: {
          expression: { type: 'string' },
          count: {
            type: 'number',
            description: 'Number of upcoming fires to compute. Default 5, max 20.',
            default: 5,
          },
          after: {
            type: 'string',
            description: 'ISO-8601 timestamp to compute fires after. Default: now.',
          },
        },
        required: ['expression'],
      },
    },
  ],
  'api-integrations': [
    {
      name: 'api_describe_webhook',
      description:
        'Returns guidance for designing a webhook endpoint for the given event type, including HMAC verification, retry, and idempotency advice.',
      input_schema: {
        type: 'object',
        properties: { eventType: { type: 'string' } },
        required: ['eventType'],
      },
    },
  ],
  'memory-rag': [
    {
      name: 'memory_chunk_text',
      description:
        'Splits text into overlapping ~512-token chunks suitable for RAG embedding.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          chunkSize: { type: 'number', default: 512 },
          overlap: { type: 'number', default: 64 },
        },
        required: ['text'],
      },
    },
  ],
  'code-development': [
    {
      name: 'code_review_snippet',
      description:
        'Returns a code review for a given snippet, focused on the building\'s curriculum (test coverage, idiomatic style, common bugs).',
      input_schema: {
        type: 'object',
        properties: { language: { type: 'string' }, code: { type: 'string' } },
        required: ['language', 'code'],
      },
    },
  ],
  'messaging-channels': [
    {
      name: 'channels_normalize_message',
      description:
        'Converts a platform-specific message (Discord/Telegram/Slack) into the agent-internal common message format.',
      input_schema: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['discord', 'telegram', 'slack', 'twitter'] },
          payload: { type: 'object', properties: {} },
        },
        required: ['platform', 'payload'],
      },
    },
  ],
  'mcp-tool-use': [
    {
      name: 'mcp_validate_tool_schema',
      description:
        'Validates an OpenAI/Anthropic tool definition for completeness and clarity.',
      input_schema: {
        type: 'object',
        properties: { tool: { type: 'object', properties: {} } },
        required: ['tool'],
      },
    },
  ],
  'visual-creation': [
    {
      name: 'visual_pick_model',
      description:
        'Recommends a frontier image/video/3D model for the given task and budget.',
      input_schema: {
        type: 'object',
        properties: {
          mediaType: { type: 'string', enum: ['image', 'video', '3d'] },
          budget: { type: 'string', enum: ['low', 'mid', 'high'] },
        },
        required: ['mediaType'],
      },
    },
  ],
  'app-publishing': [
    {
      name: 'publishing_review_checklist',
      description:
        'Returns a pre-submission checklist for the given target store (Apple, Google Play, Microsoft Store, Steam, etc.).',
      input_schema: {
        type: 'object',
        properties: {
          store: {
            type: 'string',
            enum: ['apple', 'google-play', 'microsoft-store', 'steam', 'itch', 'epic'],
          },
        },
        required: ['store'],
      },
    },
  ],
  'agent-security': [
    {
      name: 'security_check_prompt',
      description:
        'Scans a user prompt for prompt-injection patterns. Returns flags + suggested mitigations.',
      input_schema: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
      },
    },
  ],
  'deployment-ops': [
    {
      name: 'ops_size_resources',
      description:
        'Suggests CPU/memory/replica counts for an agent fleet given expected QPS and per-request latency.',
      input_schema: {
        type: 'object',
        properties: {
          qps: { type: 'number' },
          p95LatencyMs: { type: 'number' },
        },
        required: ['qps', 'p95LatencyMs'],
      },
    },
  ],
};

/** Lookup helper: returns the merged tool set for a building (game + domain). */
export function getToolsForBuilding(buildingId: string): ToolDefinition[] {
  const domain = BUILDING_TOOLS[buildingId] ?? [];
  return [...domain];
}
