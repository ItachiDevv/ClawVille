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
  // === Cron Hub (Tide Clock Grotto) ===
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
  {
    id: 'advanced-scheduling',
    name: 'Advanced Scheduling Patterns',
    description: 'Complex scheduling: chaining, retries, dead-letter queues, and distributed cron.',
    icon: '🕰️',
    price: 12,
    building: 'cron-hub',
    knowledgeEntries: [
      'Distributed cron uses leader election to ensure only one node runs a scheduled task across a cluster.',
      'Dead-letter queues capture failed cron jobs for later inspection and retry without blocking the schedule.',
      'Job chaining triggers downstream tasks on completion — build complex workflows from simple cron primitives.',
      'Timezone-aware scheduling is essential for global agents — always store schedules in UTC and convert at execution time.',
    ],
  },

  // === Webhook Gateway (Current Gateway) ===
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
  {
    id: 'event-driven-agents',
    name: 'Event-Driven Agent Design',
    description: 'Build reactive agents that respond to real-world events in real time.',
    icon: '⚡',
    price: 14,
    building: 'webhook-gateway',
    knowledgeEntries: [
      'Event-driven architecture decouples producers from consumers — agents react to events without tight coupling to sources.',
      'Event sourcing stores all state changes as an immutable log — replay events to reconstruct any past state.',
      'CQRS separates read and write models — agents can process incoming events while serving fast queries independently.',
      'Webhook fan-out distributes a single event to multiple agent handlers, enabling parallel processing pipelines.',
    ],
  },

  // === Memory Vault (Abyssal Vault) ===
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
  {
    id: 'memory-architecture',
    name: 'Memory Architecture Deep Dive',
    description: 'Advanced memory patterns: episodic recall, memory consolidation, and forgetting curves.',
    icon: '🗃️',
    price: 16,
    building: 'memory-vault',
    knowledgeEntries: [
      'Episodic memory stores specific interaction sequences — agents recall past conversations with temporal context.',
      'Memory consolidation periodically summarizes and compresses old memories to save storage while preserving key insights.',
      'Forgetting curves model how memory relevance decays over time — prioritize recent and frequently accessed memories.',
      'Hybrid search combines keyword matching with vector similarity for more accurate memory retrieval.',
    ],
  },

  // === Skill Forge (Hydrothermal Forge) ===
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
  {
    id: 'skill-composition',
    name: 'Skill Composition Patterns',
    description: 'Combine multiple skills into powerful agent workflows.',
    icon: '🧩',
    price: 18,
    building: 'skill-forge',
    knowledgeEntries: [
      'Skill composition chains multiple capabilities — a research skill feeds into a summarization skill then a publishing skill.',
      'Dependency injection lets skills share services like databases, API clients, and caches without tight coupling.',
      'Skill versioning ensures agents can upgrade individual capabilities without breaking the entire skill graph.',
      'Capability negotiation lets agents discover what skills peers have and request collaboration dynamically.',
    ],
  },

  // === Channel Bridge (Coral Bridge) ===
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
  {
    id: 'channel-orchestration',
    name: 'Channel Orchestration',
    description: 'Coordinate agent behavior across multiple channels simultaneously.',
    icon: '📡',
    price: 13,
    building: 'channel-bridge',
    knowledgeEntries: [
      'Channel-aware context lets agents tailor responses to the platform — formal on email, casual on Discord.',
      'Cross-channel message routing forwards relevant information between platforms (e.g., Discord alert triggers Telegram notification).',
      'Channel priority queues ensure high-priority platforms get responses first during traffic spikes.',
      'Unified analytics aggregate engagement metrics across all channels for holistic performance insights.',
    ],
  },

  // === Tool Workshop (Salvage Workshop) ===
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
  {
    id: 'custom-tool-building',
    name: 'Custom Tool Building',
    description: 'Create your own tools from APIs, databases, and external services.',
    icon: '⚒️',
    price: 15,
    building: 'tool-workshop',
    knowledgeEntries: [
      'API wrapper tools expose external services to agents — define input schemas, handle auth, and format responses.',
      'Database tools let agents query and update structured data — always use parameterized queries to prevent injection.',
      'Tool composition chains multiple tools into workflows — the output of one tool becomes the input of the next.',
      'Error handling in tools should return structured error messages the agent can understand and recover from gracefully.',
    ],
  },

  // === Canvas Studio (Biolume Studio) ===
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
  {
    id: 'generative-art-agents',
    name: 'Generative Art with Agents',
    description: 'Use AI agents to create and iterate on generative art and visuals.',
    icon: '🖼️',
    price: 14,
    building: 'canvas-studio',
    knowledgeEntries: [
      'Generative art agents combine rule-based systems with AI creativity to produce unique visual outputs.',
      'SVG generation lets agents create scalable vector art programmatically — perfect for logos, icons, and diagrams.',
      'Image generation APIs like DALL-E and Stable Diffusion can be wrapped as agent tools for on-demand visual creation.',
      'Iterative refinement loops let agents generate, critique, and improve their own visual outputs.',
    ],
  },

  // === Voice Tower (Echo Spire) ===
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
  {
    id: 'conversational-voice-ai',
    name: 'Conversational Voice AI',
    description: 'Build natural voice agents with interruption handling and emotion detection.',
    icon: '🎙️',
    price: 16,
    building: 'voice-tower',
    knowledgeEntries: [
      'Barge-in handling lets users interrupt the agent mid-speech — the agent stops talking and processes the new input.',
      'Emotion detection from voice prosody (pitch, speed, volume) helps agents adapt their tone to the user emotional state.',
      'Streaming TTS reduces perceived latency — start speaking the first sentence while generating the rest.',
      'Multi-language voice agents use language detection on the first utterance to switch STT and TTS models automatically.',
    ],
  },

  // === Security Fortress (Shell Fortress) ===
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
  {
    id: 'threat-modeling-agents',
    name: 'Threat Modeling for AI Agents',
    description: 'Identify and mitigate security risks in autonomous agent systems.',
    icon: '🛡️',
    price: 18,
    building: 'security-fortress',
    knowledgeEntries: [
      'Agent threat modeling maps attack surfaces: user inputs, tool invocations, memory access, and external API calls.',
      'Sandboxed execution limits agent capabilities — restrict file system access, network calls, and resource consumption.',
      'Output filtering catches harmful content before it reaches users — combine rule-based filters with classifier models.',
      'Principle of least privilege: agents should only have the minimum permissions needed for their current task.',
    ],
  },

  // === Config Citadel (Nautilus Citadel) ===
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
  {
    id: 'scaling-agent-fleets',
    name: 'Scaling Agent Fleets',
    description: 'Run hundreds of agents efficiently with resource management and orchestration.',
    icon: '🚀',
    price: 15,
    building: 'config-citadel',
    knowledgeEntries: [
      'Agent fleet management orchestrates many agents from a single control plane — start, stop, update, and monitor at scale.',
      'Resource pooling shares LLM API quotas across agents — a token budget manager prevents any single agent from exhausting limits.',
      'Blue-green deployments update agents without downtime — route traffic to the new version after health checks pass.',
      'Observability dashboards track agent latency, error rates, and token usage across the entire fleet.',
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
