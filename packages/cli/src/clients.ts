import type { ClientId } from './args';
import { stripControl } from './text';

export interface ClientInfo {
  readonly id: ClientId;
  /** The program name on PATH. */
  readonly bin: string;
  readonly label: string;
  /** The env var that moves this client's config folder (used by the local e2e script only). */
  readonly configEnv: string;
}

export const CLIENTS: readonly ClientInfo[] = [
  { id: 'claude-code', bin: 'claude', label: 'Claude Code', configEnv: 'CLAUDE_CONFIG_DIR' },
  { id: 'codex-cli', bin: 'codex', label: 'Codex CLI', configEnv: 'CODEX_HOME' },
  { id: 'hermes', bin: 'hermes', label: 'Hermes', configEnv: 'HERMES_HOME' },
];

export function clientInfo(id: ClientId): ClientInfo {
  return CLIENTS.find((client) => client.id === id)!;
}

/**
 * Server names from `hermes mcp list` text output (table rows after the line of
 * box characters). Returns [] for "No MCP servers configured."
 */
export function parseHermesList(output: string): string[] {
  const lines = stripControl(output).split('\n');
  const separator = lines.findIndex((line) => /^\s*─{4,}/.test(line));
  if (separator < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(separator + 1)) {
    const name = line.trim().split(/\s+/)[0];
    if (!name) break;
    names.push(name);
  }
  return names;
}

/** Server names from `codex mcp list --json`. Returns null when the output is not the expected JSON. */
export function parseCodexListJson(output: string): string[] | null {
  const start = output.indexOf('[');
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(output.slice(start));
    if (!Array.isArray(parsed)) return null;
    const names: string[] = [];
    for (const item of parsed) {
      if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') {
        names.push((item as { name: string }).name);
      }
    }
    return names;
  } catch {
    return null;
  }
}
