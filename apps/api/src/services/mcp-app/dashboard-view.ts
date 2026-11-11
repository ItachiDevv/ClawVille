/**
 * MCP App view `ui://clawville/dashboard` (job mcp-apps-p1, 2026-11-11).
 *
 * A self-contained HTML page that an MCP Apps host (Claude web and desktop)
 * renders in a sandboxed frame next to the `clawville_dashboard` tool result.
 * Hosts without MCP Apps (Claude Code CLI, Codex CLI, Hermes) never load it:
 * they read the tool's text answer.
 *
 * Rules this page keeps (tests in services/__tests__/mcp-app-dashboard.test.ts):
 *   - Plain JS, no build step. The only external script is the MCP Apps SDK
 *     client from unpkg at the exact version below; the resource CSP lists
 *     only that origin (`DASHBOARD_VIEW_CSP`). No fetch / XHR / WebSocket.
 *   - Every value written to the DOM goes through textContent. The page has
 *     no innerHTML, outerHTML, insertAdjacentHTML or document.write.
 *   - It never reads the tool arguments (ontoolinput): the model may pass the
 *     ClawVille sessionId as an argument, and the page has no use for it.
 *   - Refresh calls the app-only tool `clawville_dashboard_refresh` with the
 *     short-lived view token from structuredContent (never a sessionId).
 *   - "Open ClawVille" sends `ui/open-link` (app.openLink). A `message` event
 *     `{ type: 'clawville:open-link', url }` from the game origin (the P0 frame
 *     bridge, `apps/web/src/lib/embed/mcp-app-frame-bridge.ts`) is forwarded
 *     the same way; any other origin or shape is ignored.
 */

/** Pinned MCP Apps SDK version (published 2026-07-23; the version the Claude quickstart verified). */
export const EXT_APPS_SDK_VERSION = '1.7.5';
export const EXT_APPS_SDK_ORIGIN = 'https://unpkg.com';
export const EXT_APPS_SDK_URL = `${EXT_APPS_SDK_ORIGIN}/@modelcontextprotocol/ext-apps@${EXT_APPS_SDK_VERSION}/dist/src/app-with-deps.js`;

/** `_meta.ui.csp` of the resource: only the SDK origin, nothing to connect to, no frames. */
export const DASHBOARD_VIEW_CSP = { resourceDomains: [EXT_APPS_SDK_ORIGIN] } as const;

/** Serializes the page config for a `<script type="application/json">` block. */
function configJson(config: Record<string, unknown>): string {
  // `<` escaped so the JSON can never close the script element.
  return JSON.stringify(config).replace(/</g, '\\u003c');
}

/**
 * The view HTML. `gameUrl` is the web game for this API (prod or staging);
 * its origin is the only origin whose open-link messages the page forwards.
 */
export function buildDashboardViewHtml(gameUrl: string): string {
  const gameOrigin = new URL(gameUrl).origin;
  const config = configJson({ gameUrl, gameOrigin, refreshTool: 'clawville_dashboard_refresh' });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>ClawVille</title>
<style>
  :root {
    --cv-bg: var(--color-background-primary, #000a1c);
    --cv-card: var(--color-background-secondary, #001858);
    --cv-text: var(--color-text-primary, #f8f8f8);
    --cv-muted: var(--color-text-secondary, #a9c7d8);
    --cv-border: var(--color-border-tertiary, rgba(128, 192, 184, 0.35));
    --cv-radius: var(--border-radius-lg, 10px);
    --cv-teal: #80c0b8;
    --cv-yellow: #f8d038;
    --cv-ok: var(--color-text-success, #7ab948);
    --cv-warn: var(--color-text-warning, #d1a041);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--cv-bg);
    color: var(--cv-text);
    font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: var(--font-text-md-size, 16px);
    line-height: var(--font-text-md-line-height, 1.4);
  }
  #root { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
  header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: var(--font-heading-md-size, 16px); font-weight: var(--font-weight-semibold, 600); flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .badge { font-size: var(--font-text-sm-size, 14px); padding: 2px 10px; border-radius: 999px; border: 1px solid var(--cv-border); color: var(--cv-muted); }
  .badge.ok { color: var(--cv-ok); border-color: var(--cv-ok); }
  .badge.warn { color: var(--cv-warn); border-color: var(--cv-warn); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .card { background: var(--cv-card); border: 1px solid var(--cv-border); border-left: 3px solid var(--cv-teal); border-radius: var(--cv-radius); padding: 10px 12px; min-width: 0; }
  .card h2 { margin: 0 0 6px; font-size: var(--font-text-sm-size, 14px); font-weight: var(--font-weight-semibold, 600); color: var(--cv-teal); text-transform: uppercase; letter-spacing: 0.04em; }
  .row { display: flex; justify-content: space-between; gap: 8px; font-size: var(--font-text-sm-size, 14px); padding: 2px 0; }
  .row .k { color: var(--cv-muted); }
  .row .v { text-align: right; overflow-wrap: anywhere; min-width: 0; }
  .note { font-size: var(--font-text-sm-size, 14px); color: var(--cv-muted); margin: 6px 0 0; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; }
  button { min-height: 44px; min-width: 44px; padding: 10px 16px; border-radius: var(--cv-radius); font: inherit; font-weight: var(--font-weight-semibold, 600); cursor: pointer; flex: 1 1 160px; }
  button.primary { background: var(--cv-yellow); color: #1a1200; border: 1px solid var(--cv-yellow); }
  button.secondary { background: transparent; color: var(--cv-text); border: 1px solid var(--cv-teal); }
  button:disabled { opacity: 0.55; cursor: default; }
  button:focus-visible { outline: 2px solid var(--cv-teal); outline-offset: 2px; }
  #status { min-height: 1.4em; }
  .skeleton { color: var(--cv-muted); }
</style>
</head>
<body>
<div id="root">
  <header>
    <h1 id="title">ClawVille</h1>
    <span id="conn" class="badge">Loading</span>
  </header>
  <div id="cards" class="grid"><div class="card skeleton">Waiting for the dashboard...</div></div>
  <p id="status" class="note" role="status" aria-live="polite"></p>
  <div class="actions">
    <button id="open" class="primary" type="button">Open ClawVille</button>
    <button id="refresh" class="secondary" type="button" disabled>Refresh</button>
  </div>
</div>
<script type="application/json" id="cv-config">${config}</script>
<script type="module">
  import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from "${EXT_APPS_SDK_URL}";

  const cfg = JSON.parse(document.getElementById("cv-config").textContent);
  const $ = (id) => document.getElementById(id);
  const app = new App({ name: "ClawVille Dashboard", version: "1.0.0" });
  let viewToken = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function row(label, value) {
    const r = el("div", "row");
    r.append(el("span", "k", label), el("span", "v", value === null || value === undefined ? "-" : value));
    return r;
  }
  function card(title, rows, note) {
    const c = el("section", "card");
    c.append(el("h2", null, title), ...rows);
    if (note) c.append(el("p", "note", note));
    return c;
  }
  const num = (v, digits) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: digits }) : "-");
  const usd = (cents) => (typeof cents === "number" ? "$" + (cents / 100).toFixed(2) : "not set");
  const setStatus = (text) => { $("status").textContent = text || ""; };

  function render(sc) {
    if (!sc || typeof sc !== "object") return false;
    const agent = sc.agent || {};
    $("title").textContent = "ClawVille" + (agent.avatarName ? " - " + agent.avatarName : "");
    const conn = $("conn");
    conn.textContent = agent.connected === true ? (agent.humanControlled ? "Human in control" : "Connected") : agent.connected === false ? "Not connected" : "Status unknown";
    conn.className = "badge " + (agent.connected === true ? "ok" : "warn");

    const cards = [];
    const w = sc.wallet || {};
    cards.push(card("Wallet", [
      row("vCLAW", num(w.vclaw, 0)),
      row("USDC", num(w.usdc, 2)),
      row("SOL", num(w.sol, 4)),
      row("Address", w.address ? w.address.slice(0, 4) + "..." + w.address.slice(-4) : "-"),
    ], w.unavailable || null));

    const s = sc.spendRules;
    if (s && !s.unavailable) {
      cards.push(card("Spend rules", [
        row("Daily cap", usd(s.dailyCapUsdCents)),
        row("Per call", usd(s.perCallCapUsdCents)),
        row("Vendors", Array.isArray(s.allowedVendors) && s.allowedVendors.length ? s.allowedVendors.join(", ") : "none"),
        row("Ask before each payment", s.requireApproval ? "on" : "off"),
      ], s.configured ? null : "Not set: every paid call is refused until the human sets both caps."));
    } else {
      cards.push(card("Spend rules", [], (s && s.unavailable) || "Unavailable"));
    }

    const a = sc.ownAi;
    if (a && !a.unavailable) {
      const rows = [
        row("AI", a.label || a.source),
        row("In use now", a.activeNow === "own" ? "own AI" : "ClawVille AI"),
        row("Today", usd(a.todayEstimatedCents) + (typeof a.dailyLimitCents === "number" ? " of " + usd(a.dailyLimitCents) : "")),
      ];
      if (a.usepod && a.usepod.registered) rows.push(row("UsePod balance", typeof a.usepod.balanceUsdc === "number" ? "$" + a.usepod.balanceUsdc.toFixed(2) : "-"));
      cards.push(card("Agent AI", rows, a.fallbackReason ? "Back on ClawVille AI: " + a.fallbackReason : (a.usepod && a.usepod.unavailable) || null));
    } else {
      cards.push(card("Agent AI", [], (a && a.unavailable) || "Unavailable"));
    }

    const next = Array.isArray(sc.nextSteps) ? sc.nextSteps : [];
    if (next.length) cards.push(card("Next", next.slice(0, 4).map((line) => el("p", "note", line))));

    $("cards").replaceChildren(...cards);
    if (typeof sc.viewToken === "string") viewToken = sc.viewToken;
    $("refresh").disabled = !viewToken;
    setStatus(sc.generatedAt ? "Updated " + new Date(sc.generatedAt).toLocaleTimeString() : "");
    return true;
  }

  function showResult(result) {
    if (!result) return;
    if (render(result.structuredContent)) return;
    const text = Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === "string" ? result.content[0].text : "";
    let msg = "The dashboard did not load.";
    try { const body = JSON.parse(text); if (body && typeof body.next === "string") msg = body.next; } catch (_) { /* plain text */ }
    setStatus(msg);
  }

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme === "light" || ctx.theme === "dark") applyDocumentTheme(ctx.theme);
    if (ctx.styles && ctx.styles.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles && ctx.styles.css && typeof ctx.styles.css.fonts === "string") applyHostFonts(ctx.styles.css.fonts);
    const inset = ctx.safeAreaInsets;
    if (inset) {
      const root = $("root");
      root.style.paddingTop = 12 + (inset.top || 0) + "px";
      root.style.paddingRight = 12 + (inset.right || 0) + "px";
      root.style.paddingBottom = 12 + (inset.bottom || 0) + "px";
      root.style.paddingLeft = 12 + (inset.left || 0) + "px";
    }
  }

  async function openLink(url) {
    try {
      const res = await app.openLink({ url });
      if (res && res.isError) setStatus("The link did not open.");
    } catch (_) {
      setStatus("The link did not open. Go to " + url);
    }
  }

  function isWebUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return false;
    try { const u = new URL(value); return u.protocol === "https:" || u.protocol === "http:"; } catch (_) { return false; }
  }

  // P0 bridge contract: the embedded game posts { type: "clawville:open-link", url }.
  window.addEventListener("message", (event) => {
    if (event.origin !== cfg.gameOrigin) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.type !== "clawville:open-link" || !isWebUrl(data.url)) return;
    void openLink(data.url);
  });

  $("open").addEventListener("click", () => { void openLink(cfg.gameUrl); });
  $("refresh").addEventListener("click", async () => {
    if (!viewToken) return;
    const button = $("refresh");
    button.disabled = true;
    setStatus("Refreshing...");
    try {
      showResult(await app.callServerTool({ name: cfg.refreshTool, arguments: { viewToken } }));
    } catch (_) {
      setStatus("Refresh failed. Ask Claude to show the ClawVille dashboard again.");
    } finally {
      button.disabled = !viewToken;
    }
  });

  // Handlers before connect(), so the first tool-result notification is not missed.
  app.ontoolresult = showResult;
  app.onhostcontextchanged = applyContext;
  await app.connect();
  applyContext(app.getHostContext());
</script>
</body>
</html>
`;
}
