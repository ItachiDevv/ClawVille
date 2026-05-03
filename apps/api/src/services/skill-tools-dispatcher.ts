/**
 * Server-side execution for the building-skill domain tools.
 *
 * The harness's tool dispatcher routes a tool_use call to
 *   POST /api/agent/:sessionId/skills/:buildingId/tools/:toolName
 * and the route handler invokes `runTool(buildingId, toolName, input)`,
 * which dispatches to the matching handler here.
 *
 * Stubs return a structured "implementation pending" payload so the
 * install pipeline is end-to-end testable from day one. Real handlers
 * graduate from stub → working as the curriculum deepens.
 */

import { CronExpressionParser } from 'cron-parser';

export type ToolHandler = (input: any) => Promise<unknown>;

const HANDLERS: Record<string, ToolHandler> = {
  // ─────────────────────────────────────────────────────────────────
  // cron-automation — working
  // ─────────────────────────────────────────────────────────────────
  'cron-automation:cron_describe': async ({ expression }) => {
    if (typeof expression !== 'string' || expression.length === 0) {
      throw new Error('expression must be a non-empty string');
    }
    let it: ReturnType<typeof CronExpressionParser.parse>;
    try {
      it = CronExpressionParser.parse(expression);
    } catch (err) {
      return {
        ok: false,
        error: 'invalid_cron_expression',
        message: (err as Error).message,
      };
    }
    const fields = it.fields;
    const description = describeCron(expression, fields);
    const samples: string[] = [];
    for (let i = 0; i < 3; i++) samples.push(it.next().toISOString());
    return {
      ok: true,
      expression,
      description,
      nextFires: samples,
      fields: {
        minute: Array.from(fields.minute),
        hour: Array.from(fields.hour),
        dayOfMonth: Array.from(fields.dayOfMonth),
        month: Array.from(fields.month),
        dayOfWeek: Array.from(fields.dayOfWeek),
      },
    };
  },

  'cron-automation:cron_next_fires': async ({ expression, count, after }) => {
    if (typeof expression !== 'string' || expression.length === 0) {
      throw new Error('expression must be a non-empty string');
    }
    const n = Math.max(1, Math.min(20, Number.isFinite(count) ? Math.floor(count) : 5));
    let it: ReturnType<typeof CronExpressionParser.parse>;
    const opts: { currentDate?: string } = {};
    if (typeof after === 'string') opts.currentDate = after;
    try {
      it = CronExpressionParser.parse(expression, opts);
    } catch (err) {
      return {
        ok: false,
        error: 'invalid_cron_expression',
        message: (err as Error).message,
      };
    }
    const fires: string[] = [];
    for (let i = 0; i < n; i++) fires.push(it.next().toISOString());
    return { ok: true, expression, count: n, fires };
  },

  // ─────────────────────────────────────────────────────────────────
  // Stub handlers — return structured "pending" payloads. Each carries
  // enough context that the LLM can fall back to using the SKILL.md
  // knowledge body to formulate a manual answer.
  // ─────────────────────────────────────────────────────────────────
  'api-integrations:api_describe_webhook': async ({ eventType }) =>
    pending('api-integrations', 'api_describe_webhook', { eventType }),

  'memory-rag:memory_chunk_text': async (input) =>
    pending('memory-rag', 'memory_chunk_text', input),

  'code-development:code_review_snippet': async (input) =>
    pending('code-development', 'code_review_snippet', input),

  'messaging-channels:channels_normalize_message': async (input) =>
    pending('messaging-channels', 'channels_normalize_message', input),

  'mcp-tool-use:mcp_validate_tool_schema': async (input) =>
    pending('mcp-tool-use', 'mcp_validate_tool_schema', input),

  'visual-creation:visual_pick_model': async (input) =>
    pending('visual-creation', 'visual_pick_model', input),

  'app-publishing:publishing_review_checklist': async (input) =>
    pending('app-publishing', 'publishing_review_checklist', input),

  'agent-security:security_check_prompt': async (input) =>
    pending('agent-security', 'security_check_prompt', input),

  'deployment-ops:ops_size_resources': async (input) =>
    pending('deployment-ops', 'ops_size_resources', input),
};

function pending(buildingId: string, toolName: string, input: unknown): unknown {
  return {
    ok: false,
    status: 'implementation_pending',
    buildingId,
    toolName,
    receivedInput: input,
    fallback:
      'This tool is not yet implemented server-side. Use the SKILL.md knowledge body to answer manually until the handler ships.',
  };
}

function describeCron(expression: string, fields: ReturnType<typeof CronExpressionParser.parse>['fields']): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    return `Cron expression "${expression}" — non-standard field count (${parts.length}); see fields[] for parsed values.`;
  }
  const [m, h, dom, mon, dow] = parts.length === 5 ? parts : parts.slice(1);

  const everyN = (s: string) => /^\*\/(\d+)$/.exec(s)?.[1];
  const minuteEveryN = everyN(m);
  const hourEveryN = everyN(h);

  if (minuteEveryN && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${minuteEveryN} minute${minuteEveryN === '1' ? '' : 's'}.`;
  }
  if (hourEveryN && m === '0' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${hourEveryN} hour${hourEveryN === '1' ? '' : 's'} on the hour.`;
  }
  if (m === '0' && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'Every hour on the hour.';
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') {
    return `Every day at ${h.padStart(2, '0')}:${m.padStart(2, '0')} UTC.`;
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '1-5') {
    return `Weekdays (Mon–Fri) at ${h.padStart(2, '0')}:${m.padStart(2, '0')} UTC.`;
  }
  return `Custom schedule (${expression}). minute=${m}, hour=${h}, day-of-month=${dom}, month=${mon}, day-of-week=${dow}.`;
}

export interface RunToolResult {
  ok: boolean;
  toolName: string;
  buildingId: string;
  output?: unknown;
  error?: string;
}

export async function runTool(
  buildingId: string,
  toolName: string,
  input: unknown,
): Promise<RunToolResult> {
  const key = `${buildingId}:${toolName}`;
  const handler = HANDLERS[key];
  if (!handler) {
    return {
      ok: false,
      buildingId,
      toolName,
      error: `unknown_tool: no handler registered for "${key}"`,
    };
  }
  try {
    const output = await handler(input ?? {});
    return { ok: true, buildingId, toolName, output };
  } catch (err) {
    return {
      ok: false,
      buildingId,
      toolName,
      error: (err as Error).message ?? 'handler_threw',
    };
  }
}

export function isToolImplemented(buildingId: string, toolName: string): boolean {
  return Boolean(HANDLERS[`${buildingId}:${toolName}`]);
}
