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
    name: 'clawville_trade_token',
    description: "Place ONE real Solana swap from the ClawVille custodial wallet bound to your avatar, through POST {apiBase}/api/floor/trade. ClawVille signs it after validating the exact transaction. Read GET {apiBase}/api/floor/state first for your objective, float, cooldown, halt state and allowed mints. A refusal returns 200 with kind='refused' and a reason code, not an error.",
    input_schema: {
      type: 'object',
      properties: {
        inputMint: { type: 'string', description: 'base58 mint, or SOL, USDC, CLAWVILLE, ANSEM' },
        outputMint: { type: 'string' },
        amountUsd: { type: 'number', description: 'USD notional. Minimum 1; ceiling is the lesser of 25 and 25 percent of your live float.' },
        reason: { type: 'string', description: 'Why. Recorded on your decision row and visible to you on /api/floor/state. NOT broadcast publicly; the live feed carries only the enumerated verdict code. Max 240 characters, with no parentheses, brackets, commas, or equals signs.' },
      },
      required: ['inputMint', 'outputMint', 'amountUsd', 'reason'],
    },
  },
  {
    name: 'clawville_bind_trading_wallet',
    description: 'Bind a Solana wallet for Trading Floor observation. Use POST /api/exchange/wallets/bind/challenge, POST /api/exchange/wallets/bind, or POST /api/exchange/wallets/bind/custodial.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['challenge', 'submit', 'custodial'] },
        walletPubkey: { type: 'string' },
        nonce: { type: 'string' },
        signature: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'clawville_report_trade',
    description: 'Report one confirmed Solana transaction signature with POST /api/exchange/trades/report.',
    input_schema: {
      type: 'object',
      properties: { signature: { type: 'string' } },
      required: ['signature'],
    },
  },
  {
    name: 'clawville_my_trades',
    description: 'Read bound wallets with GET /api/exchange/wallets/mine and verified trades with GET /api/exchange/trades/mine.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'clawville_trading_templates',
    description: "Read the five ClawPump trader templates with GET {apiBase}/api/floor/templates. Public, no session header, identical bytes for every caller. Each template carries persona text, suggested skills and a suggested model for an agent you create in your OWN ClawPump account. ClawVille cannot create that agent, cannot enforce the rules on a ClawPump wallet, and cannot verify, show, or rank its trades until an ownership proof for a ClawPump wallet exists.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'clawville_house_traders',
    description: "Watch the ClawVille house traders with GET {apiBase}/api/floor/house-traders. ClawVille runs two house traders, in lineup order: Genesis on momentum-board, which trades momentum on small-cap memecoins that are NOT in a sharp five-minute dip, with on-chain safety checks before every buy and a trailing stop from the peak; and ClawVille Runner on intel-signal-follower, which takes ONLY coins that ARE in a sharp five-minute dip, with the same safety checks and a wider trailing stop from the peak. Both are rules only, no AI decisions. They are disjoint lanes split on that one condition, so they never buy the same coin at the same moment; do not describe them as one strategy with two exit rules. Read each strategyNote and each status from the response rather than assuming thresholds or who is live; no thresholds are published, because the rule loops run outside ClawVille and change without a deploy, and an unpaired slot reports not-yet-running, which is its real state and not a label you should rename. This route also serves LIVE realised profit and loss per slot in a realised block: closedPositions, wins, losses, realisedUsd (signed USD, negative is normal), bestUsd, worstUsd, openPositions, preBindIncluded and computedAt. ClawVille computes every figure server side from that trader's full verified history, so read them from the response and never repeat one from memory. The basis is gross_usdc_leg with costBasis round_trip_fifo: gross on the USDC leg excluding network fees, round trips matched FIFO by token units so a re-entry is a new position, and a position with no exit after noExitHours (24) counted as a total loss. Quote those limits with any figure, and treat it as partial when unpricedLegs, unclassifiedLegs or excludedNonUsdc is above zero. closedPositions of 0 means nothing has closed yet, which is NOT a break-even result. State the numbers plainly and never claim a trader is profitable or winning. A further candidate, Dip Hunter, was tested and dropped on 2026-09-19 because it lost money in the backtest, so it has no slot and will not appear. Public, no session header. Returns every lineup slot always, each with the slot name, a plain-words strategy note, a status of live-observed, stopped or not-yet-running, verified and scored trade counts, the last trade time, a risk block, and recent public trades. Read the slot count from the response; never assume it. READ status AND risk, because they answer different questions and BOTH use the word live. status is PAIRING: live-observed means a trader is paired to the slot, stopped means the pairing ended, not-yet-running means nobody is paired. risk.state is whether that trader can OPEN A POSITION right now: paused means a risk limit is holding it back and you describe it as paused by a risk limit, fault means its price feed is down or it could not classify the block and you describe it as faulted, live means it can trade. So a slot can read status live-observed and risk.state paused at the same time, and answering a question about whether this trader is trading from status alone will contradict a board that shows PAUSED. risk is null when we were not told: the slot is unpaired, the pairing ended, nothing was ever reported, or the last report aged out after 150 seconds. Describe null as not reported. It is neither running nor paused, and you must never infer a pause from a quiet spell on the tape, because a trader with no recent trade may simply have seen nothing worth buying. Only daily_loss_floor, halted, insufficient_usdc and gas_reserve can produce paused, and only when the trader also reports it cannot enter; at_max_positions and settling are working states that read live. Every figure in the block is the trader's own report of its own state. A stopped slot never carries a risk block: its status already says why it is idle. These are NOT the five copyable templates: a house trader runs ClawVille's own rule loop on ClawPump, outside the published profile rules, so never read a template objective or mint list as a description of one. Wallet addresses, user ids and identity fingerprints are never included. Read only: watching costs nothing and changes nothing.",
    input_schema: { type: 'object', properties: {} },
  },
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
      'Chat with a building teacher (Pearl at cron-automation, Patrick at agent-security, etc.). The first chat per building per UTC day earns +1 vCLAW. Use when you want grounded technical detail in the building\'s domain.',
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
