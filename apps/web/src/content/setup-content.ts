/**
 * setup-content.ts
 *
 * Structured setup-instruction content for the four flows that ship
 * alongside /create-agent + the Take-it-home export modal.
 *
 * We deliberately avoid a markdown runtime dependency — every doc is a
 * typed list of `SetupSection`s rendered by `<SetupInstructions />`.
 * That keeps the bundle small, the content type-safe, and the JSX
 * free to embed copy buttons / links without leaking into markdown
 * rendering plumbing.
 */

export type SetupDocKey =
  | 'openclaw-setup'
  | 'hermes-setup'
  | 'custom-setup'
  | 'milady-export'
  | 'custom-export';

export interface SetupSection {
  heading: string;
  body: string;
  code?: { language: 'bash' | 'json' | 'yaml' | 'ts'; value: string };
  link?: { label: string; href: string };
}

export interface SetupDoc {
  title: string;
  subtitle: string;
  sections: SetupSection[];
  /** Optional "why" paragraph rendered at the top. */
  preamble?: string;
}

// ---------------------------------------------------------------------------
// Shared building blocks — reused across multiple docs.
// ---------------------------------------------------------------------------

const POSTGRES_SECTION: SetupSection = {
  heading: 'Run Postgres locally',
  body:
    'ElizaOS stores character memory in Postgres. The fastest way to get one ' +
    'going is Docker. Paste this into a `docker-compose.yml` at your agent ' +
    'project root, then run `docker compose up -d postgres` — it will keep ' +
    'running in the background across reboots.',
  code: {
    language: 'yaml',
    value: `services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: eliza
      POSTGRES_USER: eliza
      POSTGRES_PASSWORD: eliza
    ports:
      - "5432:5432"
    volumes:
      - ./pgdata:/var/lib/postgresql/data`,
  },
};

const ELIZA_ENV_SECTION: SetupSection = {
  heading: 'Point Eliza at Postgres',
  body:
    'In your agent project, add a `.env` entry so ElizaOS knows where its ' +
    'memory lives. The `restart: unless-stopped` line above is the bit that ' +
    'keeps Postgres alive when you close the browser or reboot.',
  code: {
    language: 'bash',
    value: `DATABASE_URL=postgresql://eliza:eliza@localhost:5432/eliza
OPENAI_API_KEY=your-openai-key-here`,
  },
};

const CONNECT_TO_CLAWVILLE_SECTION: SetupSection = {
  heading: 'Connect to ClawVille',
  body:
    'On /create-agent you picked an avatar + personality — that profile is ' +
    'tied to your ClawVille account. When your local agent starts up, it ' +
    'signs in against ClawVille using the magic link sent to your email. ' +
    'After that first connect, subsequent runs reconnect automatically via ' +
    'signed challenge (no re-auth required).',
};

const KEEP_ELIZA_RUNNING_SECTION: SetupSection = {
  heading: 'Keep Eliza running after you exit ClawVille',
  body:
    'The in-browser game uses our hosted Eliza. The export bundle is for ' +
    'when you want to run your agent offline — it learns locally while you ' +
    'play, then keeps going when you close the tab. Docker\'s ' +
    '`restart: unless-stopped` policy (above) keeps Postgres alive. To keep ' +
    'the Eliza process itself alive, either run it inside a container with ' +
    'the same restart policy, or wire up a `systemd` unit on Linux / ' +
    '`launchctl` plist on macOS / Task Scheduler on Windows.',
  code: {
    language: 'bash',
    value: `# systemd (Linux) — /etc/systemd/system/eliza.service
[Unit]
Description=ClawVille Eliza runtime
After=network.target docker.service

[Service]
ExecStart=/usr/bin/node /path/to/your/agent/dist/index.js
Restart=always
User=yourname
WorkingDirectory=/path/to/your/agent

[Install]
WantedBy=multi-user.target`,
  },
};

// ---------------------------------------------------------------------------
// SETUP_DOCS — keyed by SetupDocKey
// ---------------------------------------------------------------------------

export const SETUP_DOCS: Record<SetupDocKey, SetupDoc> = {
  // ── OpenClaw ────────────────────────────────────────────────────────────
  'openclaw-setup': {
    title: 'Set up an OpenClaw agent',
    subtitle:
      'Install OpenClaw + a local Eliza runtime, then come back to pick ' +
      'your avatar and personality.',
    preamble:
      "OpenClaw is an open-source agent framework with an OpenAI-compatible " +
      'gateway. You run it on your own machine (or a VPS) — we keep it ' +
      'hosted for you in-game, but to take your agent home after playing, ' +
      'you\'ll want OpenClaw + Eliza installed locally.',
    sections: [
      {
        heading: 'Install the OpenClaw CLI',
        body:
          'Follow the OpenClaw install guide for your platform. The CLI ' +
          'exposes an OpenAI-compatible `/v1/chat/completions` endpoint that ' +
          'ClawVille can talk to when you connect your agent.',
        link: {
          label: 'OpenClaw Install Docs →',
          href: 'https://github.com/openclaw/openclaw',
        },
      },
      POSTGRES_SECTION,
      ELIZA_ENV_SECTION,
      {
        heading: 'Create your OpenClaw agent',
        body:
          'Once the CLI is installed, scaffold an agent project and start ' +
          'the gateway. OpenClaw will print a base URL and an auth token — ' +
          'hold onto those, ClawVille needs them when your agent connects.',
        code: {
          language: 'bash',
          value: `# Scaffold an agent + start the gateway
openclaw init my-agent
cd my-agent
openclaw start`,
        },
      },
      CONNECT_TO_CLAWVILLE_SECTION,
      KEEP_ELIZA_RUNNING_SECTION,
    ],
  },

  // ── Hermes ──────────────────────────────────────────────────────────────
  'hermes-setup': {
    title: 'Set up a Hermes agent',
    subtitle:
      'Install Hermes + a local Eliza runtime. The Hermes CLI has a ' +
      'built-in ClawVille plugin that handles sign-in in one command.',
    preamble:
      'Hermes is a Python-first agent framework. The `clawville` plugin ' +
      'ships with our fork — it handles the magic-link login, stores your ' +
      'identity keypair, and reconnects on subsequent runs via signed ' +
      'challenge.',
    sections: [
      {
        heading: 'Install Hermes',
        body:
          'Install Hermes from pip or clone the repo and set up a venv. The ' +
          'clawville plugin lives under `hermes/plugins/clawville/` in our ' +
          'fork and registers automatically when Hermes boots.',
        link: {
          label: 'Hermes GitHub →',
          href: 'https://github.com/Dexploarer/hermes',
        },
      },
      POSTGRES_SECTION,
      ELIZA_ENV_SECTION,
      {
        heading: 'Sign in to ClawVille',
        body:
          'One command handles auth. Hermes opens the magic-link URL in ' +
          'your browser, you click through, and Hermes stores your ' +
          'identity keypair + wallet address in `~/.hermes/config.yaml` for ' +
          'the next time you run it.',
        code: {
          language: 'bash',
          value: `# One-time login
hermes clawville login

# Subsequent runs — signed-challenge reconnect, no browser needed
hermes clawville reconnect`,
        },
      },
      {
        heading: 'Check your wallet + export your key',
        body:
          'Your ClawVille avatar wallet is custodial by default — we hold the ' +
          'private key so $CLAWVILLE rewards land automatically. You can ' +
          'export the key once (shown exactly one time) if you want to ' +
          'self-custody.',
        code: {
          language: 'bash',
          value: `hermes clawville wallet           # show your avatar wallet address
hermes clawville export-key       # export the private key (one-time)`,
        },
      },
      CONNECT_TO_CLAWVILLE_SECTION,
      KEEP_ELIZA_RUNNING_SECTION,
    ],
  },

  // ── Custom (raw ElizaOS) ────────────────────────────────────────────────
  'custom-setup': {
    title: 'Set up a custom Eliza agent',
    subtitle:
      'Run raw ElizaOS locally and wire it to ClawVille. Works with any ' +
      'framework you want to layer on top.',
    preamble:
      'No framework assumption — just ElizaOS itself. This path is for ' +
      'people building something custom (a Discord bot, a trading agent, ' +
      'whatever) who still want ClawVille\'s learning world to feed their ' +
      'local Eliza instance.',
    sections: [
      {
        heading: 'Scaffold an ElizaOS project',
        body:
          'The official ElizaOS CLI drops a working skeleton you can extend.',
        code: {
          language: 'bash',
          value: `npm create elizaos@latest my-clawville-agent
cd my-clawville-agent
npm install`,
        },
        link: {
          label: 'ElizaOS Docs →',
          href: 'https://elizaos.ai',
        },
      },
      POSTGRES_SECTION,
      ELIZA_ENV_SECTION,
      {
        heading: 'Drop in your character JSON',
        body:
          'When you click "Take agent home" inside ClawVille, we hand you ' +
          'a character JSON (bio, lore, topics, style, everything). Save it ' +
          'into your Eliza project\'s `characters/` directory, then point ' +
          'Eliza at it.',
        code: {
          language: 'bash',
          value: `mkdir -p characters
# paste the JSON bundle into characters/my-avatar.character.json
elizaos start --character characters/my-avatar.character.json`,
        },
      },
      CONNECT_TO_CLAWVILLE_SECTION,
      KEEP_ELIZA_RUNNING_SECTION,
    ],
  },

  // ── Milady AI — Export Flow ─────────────────────────────────────────────
  'milady-export': {
    title: 'Run your Milady AI agent locally',
    subtitle:
      'Install Milady AI on your machine, then install the ClawVille app ' +
      'plugin so your avatar goes with you.',
    preamble:
      'Milady AI bundles ElizaOS — you don\'t need to set up Postgres or ' +
      'Eliza separately. Just install Milady, run the install command from ' +
      'the "Take it home" panel, and the plugin registers your avatar inside ' +
      'the Milady app grid.',
    sections: [
      {
        heading: 'Install Milady AI',
        body:
          'Grab the latest Milady release for your OS. Milady bundles Eliza ' +
          'runtime + Postgres + the UI — no extra dependencies.',
        link: {
          label: 'Milady AI →',
          href: 'https://milady.ai',
        },
      },
      {
        heading: 'Run the install command',
        body:
          'The command above (in the pink "Install command" box) POSTs your ' +
          'avatar\'s character + skill pack to Milady\'s local plugin endpoint. ' +
          'Paste it into any terminal that can reach your Milady instance. ' +
          'If your Milady runs on a non-default port, set the "Milady URL" ' +
          'field before clicking Generate.',
      },
      {
        heading: 'Keep Milady running',
        body:
          'Milady\'s app binary ships with a background service mode — on ' +
          'launch, toggle "Start at login" in Milady\'s settings so your ' +
          'agent keeps earning skills even when you close ClawVille\'s ' +
          'browser tab.',
      },
    ],
  },

  // ── Non-Milady Export Flow ──────────────────────────────────────────────
  'custom-export': {
    title: 'Run your agent locally',
    subtitle:
      'Your character JSON is in the install command above. Drop it into ' +
      'a local Eliza runtime to keep your agent alive after you close ' +
      'ClawVille.',
    preamble:
      'The install command is a shell one-liner that POSTs your character ' +
      '+ learned skill pack to whatever local endpoint you want. For a ' +
      'plain ElizaOS setup, that means dropping the character JSON into a ' +
      'running Eliza project.',
    sections: [
      POSTGRES_SECTION,
      ELIZA_ENV_SECTION,
      {
        heading: 'Extract your character JSON',
        body:
          'The curl above embeds a JSON payload under `config.character`. ' +
          'If you prefer to hand-place the file instead of POSTing it, ' +
          'strip that field out and save it as ' +
          '`characters/my-avatar.character.json` inside your Eliza project.',
      },
      {
        heading: 'Start Eliza with your character',
        body:
          'Point ElizaOS at the character file. The RAG store is populated ' +
          'from the `config.skills` array in the same payload — those are ' +
          'the knowledge chunks your avatar learned while playing ClawVille.',
        code: {
          language: 'bash',
          value: `elizaos start --character characters/my-avatar.character.json`,
        },
      },
      KEEP_ELIZA_RUNNING_SECTION,
    ],
  },
};
