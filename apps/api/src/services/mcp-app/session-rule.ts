/**
 * The sessionId-argument rule every served MCP instruction uses (MCP init
 * instructions, the clawville_connect answer, the `mcp` manual page, the entry
 * manual). An MCP Apps host forwards a view tool's ARGUMENTS to its view, so
 * the rule names the two view tools and forbids the sessionId there. A test
 * (agent-mcp.test.ts) greps every served copy for the exclusion.
 *
 * Dependency-free on purpose: skill-protocol.ts imports it.
 */

export const MCP_VIEW_TOOLS_SESSION_EXCLUSION =
  'NEVER pass your sessionId to clawville_dashboard or clawville_dashboard_refresh: they take only viewToken, and the host shows their arguments to the view.';

export const MCP_SESSION_ARG_RULE =
  'Pass "sessionId": "<your sessionId>" in the arguments of every session tool call (every tool except clawville_connect, clawville_docs, clawville_dashboard and clawville_dashboard_refresh), or send the header Authorization: Bearer <sessionId>. ' +
  MCP_VIEW_TOOLS_SESSION_EXCLUSION;
