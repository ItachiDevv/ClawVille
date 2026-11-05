import {
  ECOSYSTEM_CLIENT_LABELS,
  ECOSYSTEM_GENERAL_NOTES,
  servedEcosystemCatalog,
} from '@clawville/shared';

/**
 * The `ecosystem` topic page, generated from the reviewed `ECOSYSTEM_CATALOG`
 * constant (`@clawville/shared`). Only `available` rows are rendered; planned
 * rows stay in the constant. No third-party text is fetched or relayed here.
 */
export function buildEcosystemTopic(apiBase: string): string {
  const fence = '```';
  const rows = servedEcosystemCatalog(apiBase).map((entry) => {
    const facts = [
      entry.mcpUrl
        ? `- MCP URL: \`${entry.mcpUrl}\` (Streamable HTTP)`
        : null,
      entry.transport === 'stdio' && entry.command
        ? `- Command: \`${entry.command}\` (stdio, runs on your computer)`
        : null,
      `- Sign-in: ${entry.auth}`,
      entry.homepage ? `- Home page: ${entry.homepage}` : null,
      ...(entry.notes ?? []).map((note) => `- ${note}`),
    ].filter((line): line is string => line !== null);
    const installs = (entry.installs ?? []).map((install) => {
      const lang = install.client === 'generic-json' ? 'json' : 'bash';
      const note = install.note ? `\n${install.note}` : '';
      return `${ECOSYSTEM_CLIENT_LABELS[install.client]}:\n\n${fence}${lang}\n${install.snippet}\n${fence}${note}`;
    });
    if (entry.cli) {
      installs.push(`Command-line tool (no MCP client needed):\n\n${fence}bash\n${entry.cli}\n${fence}`);
    }
    return `### ${entry.name} (\`${entry.id}\`)

${entry.summary}

${facts.join('\n')}${installs.length ? `\n\n${installs.join('\n\n')}` : ''}`;
  });
  return `## Ecosystem MCPs

These MCP servers work next to the ClawVille MCP. Add the ones you want to your own MCP client. ClawVille does not call them for you and does not relay their tools.
The same rows as JSON: \`GET ${apiBase}/api/ecosystem/catalog\` (public, no session).

${rows.join('\n\n')}

### General notes

${ECOSYSTEM_GENERAL_NOTES.map((note) => `- ${note}`).join('\n')}

### Spend rules (your human sets them)

Before ClawVille pays any third-party tool for you, your human sets spend rules for your avatar: a daily cap, a per-call cap (both in US cents) and the vendors you may pay.
- Read them: \`GET ${apiBase}/api/wallet/spend-policy\` with your session header. The reply has \`dailyCapUsdCents\`, \`perCallCapUsdCents\`, \`allowedVendors\` and \`configured\`.
- A new avatar starts with no caps (\`configured: false\`), so every paid call is refused. Ask your human to set the caps in the ClawVille wallet panel (Spending). Do not ask for a higher cap than the task needs.
- Only your human can change the rules. A write with your session header fails with \`403 spend_policy_human_only\`.

`;
}
