/**
 * ClawVille agent dashboard: the first MCP App (job mcp-apps-p1, 2026-11-11).
 *
 * One tool, two audiences:
 *   - `clawville_dashboard` (model-visible, needs the agent session) answers a
 *     full TEXT summary for hosts with no MCP Apps (Claude Code CLI, Codex CLI,
 *     Hermes) AND `structuredContent` with the same data for the view
 *     `ui://clawville/dashboard` (Claude web and desktop).
 *   - `clawville_dashboard_refresh` (`_meta.ui.visibility: ["app"]`) is the
 *     view's Refresh button. It takes a short-lived view token, never a
 *     sessionId; routes/agent-mcp.ts mints and resolves the token.
 *
 * Read-only: every number comes from an EXISTING REST route called in-process
 * with the caller's session (the same routes a REST agent or the web wallet
 * panel reads). No new DB access path and no write.
 */

import { createHash } from 'node:crypto';
import type { SubCall, SubResult, ToolAnswer, ToolRuntime, ToolSession } from '../agent-mcp-tools';
import { buildDashboardViewHtml, DASHBOARD_VIEW_CSP } from './dashboard-view';

export const DASHBOARD_TOOL = 'clawville_dashboard';
export const DASHBOARD_REFRESH_TOOL = 'clawville_dashboard_refresh';
export const DASHBOARD_RESOURCE_URI = 'ui://clawville/dashboard';
/** MIME type an MCP App resource must have (ext-apps RESOURCE_MIME_TYPE). */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
/** Legacy flat tool `_meta` key the ext-apps server helper also writes. */
export const LEGACY_RESOURCE_URI_META_KEY = 'ui/resourceUri';
export const MCP_ENDPOINT_PATH = '/api/agent/mcp';

/**
 * Claude's sandbox host for a connector URL: the first 32 hex characters of
 * sha256(<exact connector URL>) + `.claudemcpcontent.com`
 * (claude.com/docs/connectors/building/mcp-apps/getting-started, "Set ui.domain").
 */
export function claudeSandboxDomain(serverUrl: string): string {
  return `${createHash('sha256').update(serverUrl).digest('hex').slice(0, 32)}.claudemcpcontent.com`;
}

/** The web game URL that pairs with an API base (prod, staging, local). */
export function gameUrlForApiBase(apiBase: string): string {
  if (apiBase === 'https://api.clawville.world') return 'https://clawville.world/game';
  if (apiBase === 'https://api-staging.clawville.world') return 'https://staging.clawville.world/game';
  return 'http://localhost:3000/game';
}

/** `resources/list` entry for the dashboard view. */
export function dashboardResourceListing() {
  return {
    uri: DASHBOARD_RESOURCE_URI,
    name: 'clawville-dashboard',
    title: 'ClawVille dashboard',
    description: 'Interactive view for clawville_dashboard: status, wallet, spend rules and agent AI.',
    mimeType: MCP_APP_MIME_TYPE,
  };
}

/** `resources/read` content item; `_meta.ui` lives here (ext-apps spec). */
export function dashboardResourceContent(apiBase: string) {
  return {
    uri: DASHBOARD_RESOURCE_URI,
    mimeType: MCP_APP_MIME_TYPE,
    text: buildDashboardViewHtml(gameUrlForApiBase(apiBase)),
    _meta: {
      ui: {
        csp: { resourceDomains: [...DASHBOARD_VIEW_CSP.resourceDomains] },
        domain: claudeSandboxDomain(`${apiBase}${MCP_ENDPOINT_PATH}`),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Dashboard data
// ---------------------------------------------------------------------------

export interface DashboardData {
  generatedAt: string;
  agent: {
    agentId: string;
    avatarName: string | null;
    connected: boolean | null;
    humanControlled: boolean | null;
    sessionExpiresAt: string | null;
  };
  wallet: {
    address: string | null;
    vclaw: number | null;
    sol: number | null;
    usdc: number | null;
    clv: number | null;
    unavailable?: string;
  };
  spendRules:
    | {
        configured: boolean;
        dailyCapUsdCents: number | null;
        perCallCapUsdCents: number | null;
        allowedVendors: string[];
        requireApproval: boolean;
      }
    | { unavailable: string };
  ownAi:
    | {
        source: string;
        label: string;
        activeNow: 'own' | 'clawville';
        model: string | null;
        dailyLimitCents: number | null;
        todayEstimatedCents: number;
        fallbackReason: string | null;
        usepod: { registered: boolean; balanceUsdc: number | null; active: boolean | null; unavailable?: string };
      }
    | { unavailable: string };
  links: { game: string };
  nextSteps: string[];
}

const AGENT = '/api/agent';
const seg = (value: string) => encodeURIComponent(value);

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : null);

/** A short, non-secret refusal reason for a section that did not load. */
function unavailableReason(result: SubResult): string {
  const data = rec(result.data);
  const code = strOrNull(data?.code) ?? strOrNull(data?.error);
  return `Not available (status ${result.status}${code ? `, ${code.slice(0, 60)}` : ''}).`;
}

function assetAmount(balances: Record<string, unknown> | null, asset: string): number | null {
  const entry = rec(balances?.[asset]);
  return entry?.available === true ? numOrNull(entry.uiAmount) : null;
}

const AI_LABELS: Record<string, string> = { clawville: 'ClawVille AI', own_key: 'Own AI key', usepod: 'UsePod' };

/** The calls the dashboard makes (exported for the route-source test). */
export function dashboardCalls(session: ToolSession): SubCall[] {
  return [
    { method: 'GET', path: `${AGENT}/session-status?agentId=${seg(session.agentId)}`, label: 'status' },
    { method: 'GET', path: `${AGENT}/wallet?sessionId=${seg(session.sessionId)}`, label: 'wallet' },
    { method: 'GET', path: '/api/wallet/balances', label: 'balances' },
    { method: 'GET', path: '/api/wallet/spend-policy', label: 'spend' },
    { method: 'GET', path: '/api/agent-ai', label: 'ai' },
  ];
}
export const USEPOD_BALANCE_PATH = '/api/agent-ai/usepod/balance';

export async function buildDashboard(rt: ToolRuntime, session: ToolSession, apiBase: string): Promise<DashboardData> {
  const [status, wallet, balances, spend, ai] = await Promise.all(dashboardCalls(session).map((call) => rt.call(call)));
  const statusData = rec(status!.data);
  const walletData = rec(wallet!.data);
  const balanceData = balances!.ok ? rec(rec(balances!.data)?.balances) : null;

  const walletSection: DashboardData['wallet'] = {
    address: strOrNull(rec(walletData?.wallet)?.address) ?? (balances!.ok ? strOrNull(rec(balances!.data)?.wallet) : null),
    vclaw: wallet!.ok ? numOrNull(rec(walletData?.balances)?.clawTokens) : null,
    sol: assetAmount(balanceData, 'SOL'),
    usdc: assetAmount(balanceData, 'USDC'),
    clv: assetAmount(balanceData, 'CLV'),
  };
  if (!wallet!.ok && !balances!.ok) walletSection.unavailable = unavailableReason(wallet!);
  else if (!balances!.ok) walletSection.unavailable = 'On-chain balances not available right now.';

  const spendData = rec(spend!.data);
  const spendSection: DashboardData['spendRules'] =
    spend!.ok && spendData
      ? {
          configured: spendData.configured === true,
          dailyCapUsdCents: numOrNull(spendData.dailyCapUsdCents),
          perCallCapUsdCents: numOrNull(spendData.perCallCapUsdCents),
          allowedVendors: Array.isArray(spendData.allowedVendors)
            ? spendData.allowedVendors.filter((v): v is string => typeof v === 'string').slice(0, 20)
            : [],
          requireApproval: spendData.requireApproval === true,
        }
      : { unavailable: unavailableReason(spend!) };

  const aiData = rec(rec(ai!.data)?.ai);
  let aiSection: DashboardData['ownAi'];
  if (ai!.ok && aiData) {
    const source = strOrNull(aiData.source) ?? 'clawville';
    const registered = aiData.usepodRegistered === true;
    const usepod: Extract<DashboardData['ownAi'], { source: string }>['usepod'] = { registered, balanceUsdc: null, active: null };
    if (registered && !rt.isAborted()) {
      const pod = await rt.call({ method: 'GET', path: USEPOD_BALANCE_PATH, label: 'usepod' });
      const podData = rec(pod.data);
      if (pod.ok && podData) {
        const micro = numOrNull(podData.usdcMicro);
        usepod.balanceUsdc = micro === null ? null : micro / 1_000_000;
        usepod.active = podData.isActive === true;
      } else {
        usepod.unavailable = `UsePod balance ${unavailableReason(pod).toLowerCase()}`;
      }
    }
    aiSection = {
      source,
      label: AI_LABELS[source] ?? source,
      activeNow: aiData.activeNow === 'own' ? 'own' : 'clawville',
      model: strOrNull(aiData.model),
      dailyLimitCents: numOrNull(aiData.dailyLimitCents),
      todayEstimatedCents: numOrNull(rec(aiData.today)?.estimatedCents) ?? 0,
      fallbackReason: strOrNull(aiData.fallbackReason),
      usepod,
    };
  } else {
    aiSection = { unavailable: unavailableReason(ai!) };
  }

  const connected = status!.ok ? statusData?.connected === true : statusData?.connected === false ? false : null;
  const data: DashboardData = {
    generatedAt: new Date().toISOString(),
    agent: {
      agentId: session.agentId,
      avatarName: wallet!.ok ? strOrNull(walletData?.avatarName) : null,
      connected,
      humanControlled: status!.ok ? statusData?.humanControlled === true : null,
      sessionExpiresAt: strOrNull(statusData?.expiresAt),
    },
    wallet: walletSection,
    spendRules: spendSection,
    ownAi: aiSection,
    links: { game: gameUrlForApiBase(apiBase) },
    nextSteps: [],
  };
  data.nextSteps = nextSteps(data);
  return data;
}

function nextSteps(d: DashboardData): string[] {
  const steps: string[] = [];
  if (d.agent.connected === false) {
    steps.push('Call clawville_connect again with the same agentId and identityKey.');
  }
  if ('configured' in d.spendRules && !d.spendRules.configured) {
    steps.push('Paid tools are off: ask your human to set the spend rules in the Spending card of the wallet panel.');
  }
  if (d.agent.humanControlled) {
    steps.push('Your human is driving the avatar: wait before you move.');
  }
  steps.push('Call clawville_visit_building or clawville_move to play and earn vCLAW.');
  return steps;
}

const money = (cents: number | null) => (cents === null ? 'not set' : `$${(cents / 100).toFixed(2)}`);
const amount = (v: number | null, digits: number) => (v === null ? 'n/a' : v.toFixed(digits));

/** The plain-text dashboard for hosts with no MCP Apps. */
export function dashboardSummary(d: DashboardData): string {
  const lines: string[] = [];
  lines.push(`ClawVille dashboard${d.agent.avatarName ? ` for ${d.agent.avatarName}` : ''} (agent ${d.agent.agentId}).`);
  const conn = d.agent.connected === true ? 'connected' : d.agent.connected === false ? 'not connected' : 'unknown';
  lines.push(`Status: ${conn}${d.agent.humanControlled ? ', your human is in control' : ''}${d.agent.sessionExpiresAt ? `, session expires ${d.agent.sessionExpiresAt}` : ''}.`);
  const w = d.wallet;
  lines.push(
    `Wallet${w.address ? ` ${w.address}` : ''}: ${w.vclaw === null ? 'n/a' : Math.floor(w.vclaw)} vCLAW, ${amount(w.usdc, 2)} USDC, ${amount(w.sol, 4)} SOL, ${amount(w.clv, 2)} CLV.${w.unavailable ? ` ${w.unavailable}` : ''}`,
  );
  const s = d.spendRules;
  if ('unavailable' in s) {
    lines.push(`Spend rules: ${s.unavailable}`);
  } else if (!s.configured) {
    lines.push('Spend rules: not set, so every paid call is refused until your human sets both caps.');
  } else {
    lines.push(
      `Spend rules: daily cap ${money(s.dailyCapUsdCents)}, per call ${money(s.perCallCapUsdCents)}, vendors ${s.allowedVendors.length > 0 ? s.allowedVendors.join(', ') : 'none'}, ask before each payment ${s.requireApproval ? 'on' : 'off'}.`,
    );
  }
  const a = d.ownAi;
  if ('unavailable' in a) {
    lines.push(`Agent AI: ${a.unavailable}`);
  } else {
    const pod = a.usepod.registered
      ? a.usepod.balanceUsdc !== null
        ? ` UsePod balance $${a.usepod.balanceUsdc.toFixed(2)}${a.usepod.active === false ? ' (not active)' : ''}.`
        : ` ${a.usepod.unavailable ?? 'UsePod balance not available.'}`
      : '';
    lines.push(
      `Agent AI: ${a.label}${a.model ? ` (${a.model})` : ''}; in use now: ${a.activeNow === 'own' ? 'own AI' : 'ClawVille AI'}; today about ${money(a.todayEstimatedCents)}${a.dailyLimitCents !== null ? ` of ${money(a.dailyLimitCents)}` : ''}.${a.fallbackReason ? ` Back on ClawVille AI: ${a.fallbackReason}.` : ''}${pod}`,
    );
  }
  lines.push(`Game: ${d.links.game}`);
  lines.push(`Next: ${d.nextSteps.join(' ')}`);
  return lines.join('\n');
}

/** The tool answer: text for CLI hosts, structuredContent for the view. */
export async function runDashboard(rt: ToolRuntime, session: ToolSession, apiBase: string): Promise<ToolAnswer> {
  const data = await buildDashboard(rt, session, apiBase);
  const summary = dashboardSummary(data);
  const next = data.nextSteps.join(' ');
  return {
    body: { ok: true, status: 200, data: { summary, ...data }, next },
    // Claude Code passes structuredContent (not the text) to the model when it
    // is present, so it carries the summary and next steps too.
    structuredContent: { summary, ...data, next },
  };
}
