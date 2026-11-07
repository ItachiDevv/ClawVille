import { isSafeToken } from './tokenize';

export const CLIENT_IDS = ['claude-code', 'codex-cli', 'hermes'] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export const DEFAULT_API_BASE = 'https://api.clawville.world';

export type Command = 'install' | 'list' | 'add' | 'doctor' | 'help' | 'version';

export interface ParsedArgs {
  readonly command: Command;
  /** `add` only: the catalog row id. */
  readonly rowId?: string;
  readonly client?: ClientId;
  readonly apiBase: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * Validate `--api`. https only, except http on 127.0.0.1 and localhost. The value
 * must be an origin (no path, query, hash or user info). Returns the origin.
 */
export function validateApiBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--api: "${raw.slice(0, 80)}" is not a URL.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new UsageError('--api: use an https URL (http is allowed only for 127.0.0.1 and localhost).');
  }
  if (url.username !== '' || url.password !== '') throw new UsageError('--api: a user name or password in the URL is not allowed.');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#')) {
    throw new UsageError('--api: give the API origin only, for example https://api.clawville.world');
  }
  const origin = url.origin;
  if (!isSafeToken(`${origin}/api/agent/mcp`)) throw new UsageError('--api: the URL holds a character that is not allowed.');
  return origin;
}

function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

const COMMANDS: Readonly<Record<string, Command>> = { list: 'list', add: 'add', doctor: 'doctor', help: 'help' };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let client: ClientId | undefined;
  let apiBase = DEFAULT_API_BASE;
  let dryRun = false;
  let yes = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq > 0 ? arg.slice(eq + 1) : undefined;
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) throw new UsageError(`${name} needs a value.`);
      i++;
      return next;
    };
    const noValue = () => {
      if (inlineValue !== undefined) throw new UsageError(`${name} takes no value.`);
    };

    switch (name) {
      case '--dry-run':
        noValue();
        dryRun = true;
        break;
      case '--yes':
      case '-y':
        noValue();
        yes = true;
        break;
      case '--help':
      case '-h':
        noValue();
        help = true;
        break;
      case '--version':
      case '-v':
      case '-V':
        noValue();
        version = true;
        break;
      case '--api':
        apiBase = validateApiBase(takeValue());
        break;
      case '--client': {
        const value = takeValue();
        if (!isClientId(value)) throw new UsageError(`--client must be one of: ${CLIENT_IDS.join(', ')}.`);
        client = value;
        break;
      }
      default:
        if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg.slice(0, 40)}`);
        positional.push(arg);
    }
  }

  if (version) return { command: 'version', apiBase, dryRun, yes };
  if (help) return { command: 'help', apiBase, dryRun, yes };

  const [first, ...rest] = positional;
  if (first === undefined) return { command: 'install', client, apiBase, dryRun, yes };
  const command = COMMANDS[first];
  if (command === undefined) throw new UsageError(`Unknown command: ${first.slice(0, 40)}`);
  if (command === 'add') {
    if (rest.length !== 1) throw new UsageError('Usage: clawville add <id> [--client claude-code|codex-cli|hermes]');
    return { command, rowId: rest[0], client, apiBase, dryRun, yes };
  }
  if (rest.length > 0) throw new UsageError(`${first} takes no extra arguments.`);
  if (command === 'list' && client !== undefined) throw new UsageError('list takes no --client.');
  return { command, client, apiBase, dryRun, yes };
}
