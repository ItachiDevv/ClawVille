export interface KnowledgeBook {
  id: string;
  name: string;
  description: string;
  icon: string;
  price: number;
  building: string; // which building offers it
  knowledgeEntries: string[];
}

export const KNOWLEDGE_BOOKS: KnowledgeBook[] = [
  // Cron Hub
  {
    id: 'cron-scheduling-101',
    name: 'Cron Scheduling 101',
    description: 'Master cron expressions and task automation for AI agents.',
    icon: '⏰',
    price: 8,
    building: 'cron-hub',
    knowledgeEntries: [
      'Cron expressions use five fields: minute, hour, day-of-month, month, day-of-week to define recurring schedules.',
      'OpenClaw agents can register cron handlers that fire autonomously — perfect for social posting, data scraping, and heartbeat checks.',
      'Rate limiting cron tasks prevents API quota exhaustion — stagger jobs with random jitter to avoid thundering herd problems.',
      'Idempotent cron tasks are critical: if a job runs twice due to a restart, the outcome should be the same as running once.',
    ],
  },
  // Webhook Gateway
  {
    id: 'webhook-patterns',
    name: 'Webhook Patterns',
    description: 'Design reliable webhook endpoints and event-driven agent architectures.',
    icon: '🔗',
    price: 10,
    building: 'webhook-gateway',
    knowledgeEntries: [
      'Webhooks deliver real-time event notifications via HTTP POST — faster and more efficient than polling APIs.',
      'Always verify webhook signatures using HMAC-SHA256 to ensure payloads come from trusted sources.',
      'Implement retry logic with exponential backoff for webhook delivery — most providers retry 3-5 times on failure.',
      'Use a message queue between webhook ingestion and processing to handle traffic spikes without dropping events.',
    ],
  },
  // Memory Vault
  {
    id: 'vector-memory-guide',
    name: 'Vector Memory Guide',
    description: 'Understanding embeddings, LanceDB, and semantic search for agent memory.',
    icon: '🧠',
    price: 12,
    building: 'memory-vault',
    knowledgeEntries: [
      'Vector embeddings convert text into high-dimensional number arrays that capture semantic meaning — similar concepts cluster nearby.',
      'LanceDB is a serverless vector database that stores embeddings on disk with fast approximate nearest-neighbor search.',
      'OpenClaw uses a tiered memory system: short-term (conversation context), episodic (recent interactions), and long-term (persistent knowledge).',
      'Retrieval-Augmented Generation (RAG) injects relevant memories into the agent prompt at inference time, grounding responses in stored knowledge.',
      'Chunking strategies matter: split documents into overlapping 512-token windows for better retrieval quality.',
    ],
  },
  // Skill Forge
  {
    id: 'skill-development-manual',
    name: 'Skill Development Manual',
    description: 'Build, test, and publish skills to the ClawHub marketplace.',
    icon: '🔨',
    price: 15,
    building: 'skill-forge',
    knowledgeEntries: [
      'An OpenClaw skill is a self-contained module with actions, providers, and evaluators that extends agent behavior.',
      'Skills are published to ClawHub — a marketplace where developers share reusable agent capabilities.',
      'Each skill defines a manifest with name, version, capabilities, and required permissions for the host agent.',
      'Test skills in a sandbox environment before publishing — the skill runner simulates agent interactions for validation.',
    ],
  },
  // Channel Bridge
  {
    id: 'multi-platform-messaging',
    name: 'Multi-Platform Messaging',
    description: 'Connect agents to Discord, Telegram, Twitter, Farcaster and more.',
    icon: '🌉',
    price: 10,
    building: 'channel-bridge',
    knowledgeEntries: [
      'OpenClaw agents can simultaneously operate on Discord, Telegram, Twitter, Farcaster, and custom API channels.',
      'Each platform adapter normalizes messages into a common format: sender, content, channel, and metadata.',
      'Rate limits differ per platform — Discord allows 5 messages per 5 seconds, Twitter has stricter posting limits.',
      'Cross-platform identity linking lets agents recognize the same user across Discord and Telegram conversations.',
    ],
  },
  // Tool Workshop
  {
    id: 'plugin-architecture',
    name: 'Plugin Architecture',
    description: 'Design and build tools and plugins that extend agent capabilities.',
    icon: '🛠️',
    price: 12,
    building: 'tool-workshop',
    knowledgeEntries: [
      'OpenClaw plugins follow a standard interface: actions (what the agent can do), providers (data the agent can access), and evaluators (how the agent reflects).',
      'Tools are invoked through function-calling — the LLM decides when to use a tool based on the user request and tool descriptions.',
      'Good tool descriptions are critical: clear names, parameter schemas, and usage examples improve LLM tool selection accuracy.',
      'Plugin isolation ensures one faulty plugin cannot crash the entire agent runtime — each runs in its own error boundary.',
    ],
  },
  // Canvas Studio
  {
    id: 'live-canvas-rendering',
    name: 'Live Canvas Rendering',
    description: 'Create real-time visualizations and interactive canvases.',
    icon: '🎨',
    price: 10,
    building: 'canvas-studio',
    knowledgeEntries: [
      'Live Canvas lets agents render real-time charts, diagrams, and interactive UIs directly in chat.',
      'Canvas uses a declarative component model — agents describe what to render, and the framework handles layout and updates.',
      'Data-driven visualizations update automatically as underlying data changes — perfect for dashboards and monitoring.',
    ],
  },
  // Voice Tower
  {
    id: 'voice-speech-integration',
    name: 'Voice & Speech Integration',
    description: 'Add speech-to-text and text-to-speech to your agents.',
    icon: '🗼',
    price: 12,
    building: 'voice-tower',
    knowledgeEntries: [
      'Speech-to-text (STT) converts audio input into text that agents can process — popular APIs include Whisper and Deepgram.',
      'Text-to-speech (TTS) gives agents a voice — ElevenLabs and OpenAI TTS produce natural-sounding speech from text.',
      'Voice agents need low latency pipelines: STT → LLM → TTS should complete in under 2 seconds for natural conversation.',
      'Voice activity detection (VAD) determines when the user has finished speaking, enabling turn-based voice conversations.',
    ],
  },
  // Security Fortress
  {
    id: 'agent-security-handbook',
    name: 'Agent Security Handbook',
    description: 'Permissions, access control, and security best practices for AI agents.',
    icon: '🏰',
    price: 15,
    building: 'security-fortress',
    knowledgeEntries: [
      'OpenClaw uses role-based access control (RBAC) — agents, users, and tools each have defined permission scopes.',
      'Prompt injection attacks attempt to override agent instructions through user input — validate and sanitize all external text.',
      'API key rotation and secret management are essential — never hardcode credentials, use environment variables or vaults.',
      'Audit logging records every agent action — critical for debugging, compliance, and detecting anomalous behavior.',
    ],
  },
  // Config Citadel
  {
    id: 'deployment-config-guide',
    name: 'Deployment & Config Guide',
    description: 'Configure, deploy, and manage agent environments at scale.',
    icon: '⚙️',
    price: 10,
    building: 'config-citadel',
    knowledgeEntries: [
      'OpenClaw agents are configured via character JSON files that define personality, skills, model providers, and behavior rules.',
      'Environment-specific configs allow the same agent to behave differently in development, staging, and production.',
      'Docker containers package agents with all dependencies — deploy anywhere with consistent behavior.',
      'Health checks and auto-restart policies keep agents running — monitor uptime, memory usage, and response latency.',
    ],
  },
];

export const BOOK_IDS = KNOWLEDGE_BOOKS.map((b) => b.id);

/** Get books available at a specific building */
export function getBooksForBuilding(buildingId: string): KnowledgeBook[] {
  return KNOWLEDGE_BOOKS.filter((b) => b.building === buildingId);
}

/** Get a specific book by ID */
export function getBookById(bookId: string): KnowledgeBook | undefined {
  return KNOWLEDGE_BOOKS.find((b) => b.id === bookId);
}
