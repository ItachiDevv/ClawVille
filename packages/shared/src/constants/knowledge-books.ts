export interface KnowledgeBook {
  id: string;
  name: string;
  description: string;
  icon: string;
  price: number;
  building: string; // which building offers it
  knowledgeEntries: string[];
}

// Prices are in vCLAW at the A3 ¢-peg ($0.01/unit, 2026-07-07): a book costs
// $0.80–$2.20. The relative ladder is unchanged from the pre-redenomination era —
// every price was multiplied ×10 in lockstep with the balance redenomination
// (migration 0011), so purchasing power is identical (was 8–22 CT at $0.10/CT).
// Read at purchase time via getBookById().price (items.ts) — no DB copy.
export const KNOWLEDGE_BOOKS: KnowledgeBook[] = [
  // === Cron Automation (Downtown Building) ===
  {
    id: 'cron-automation-basics',
    name: 'Cron Scheduling 101',
    description: 'Master cron expressions and task automation for AI agents.',
    icon: '⏰',
    price: 80,
    building: 'cron-automation',
    knowledgeEntries: [
      'Cron expressions use five fields: minute, hour, day-of-month, month, day-of-week to define recurring schedules.',
      'OpenClaw agents can register cron handlers that fire autonomously — perfect for social posting, data scraping, and heartbeat checks.',
      'Rate limiting cron tasks prevents API quota exhaustion — stagger jobs with random jitter to avoid thundering herd problems.',
      'Idempotent cron tasks are critical: if a job runs twice due to a restart, the outcome should be the same as running once.',
    ],
  },
  {
    id: 'cron-automation-advanced',
    name: 'Advanced Scheduling Patterns',
    description: 'Complex scheduling: chaining, retries, dead-letter queues, and distributed cron.',
    icon: '🕰️',
    price: 120,
    building: 'cron-automation',
    knowledgeEntries: [
      'Distributed cron uses leader election to ensure only one node runs a scheduled task across a cluster.',
      'Dead-letter queues capture failed cron jobs for later inspection and retry without blocking the schedule.',
      'Job chaining triggers downstream tasks on completion — build complex workflows from simple cron primitives.',
      'Timezone-aware scheduling is essential for global agents — always store schedules in UTC and convert at execution time.',
    ],
  },

  // === API Integrations (Salty Spitoon) ===
  {
    id: 'api-integrations-webhooks',
    name: 'Webhook Patterns',
    description: 'Design reliable webhook endpoints and event-driven agent architectures.',
    icon: '🔗',
    price: 100,
    building: 'api-integrations',
    knowledgeEntries: [
      'Webhooks deliver real-time event notifications via HTTP POST — faster and more efficient than polling APIs.',
      'Always verify webhook signatures using HMAC-SHA256 to ensure payloads come from trusted sources.',
      'Implement retry logic with exponential backoff for webhook delivery — most providers retry 3-5 times on failure.',
      'Use a message queue between webhook ingestion and processing to handle traffic spikes without dropping events.',
    ],
  },
  {
    id: 'api-integrations-event-driven',
    name: 'Event-Driven Agent Design',
    description: 'Build reactive agents that respond to real-world events in real time.',
    icon: '⚡',
    price: 140,
    building: 'api-integrations',
    knowledgeEntries: [
      'Event-driven architecture decouples producers from consumers — agents react to events without tight coupling to sources.',
      'Event sourcing stores all state changes as an immutable log — replay events to reconstruct any past state.',
      'CQRS separates read and write models — agents can process incoming events while serving fast queries independently.',
      'Webhook fan-out distributes a single event to multiple agent handlers, enabling parallel processing pipelines.',
    ],
  },

  // === Memory RAG (Squidward's House) ===
  {
    id: 'memory-rag-vectors',
    name: 'Vector Memory Guide',
    description: 'Understanding embeddings, LanceDB, and semantic search for agent memory.',
    icon: '🧠',
    price: 120,
    building: 'memory-rag',
    knowledgeEntries: [
      'Vector embeddings convert text into high-dimensional number arrays that capture semantic meaning — similar concepts cluster nearby.',
      'LanceDB is a serverless vector database that stores embeddings on disk with fast approximate nearest-neighbor search.',
      'OpenClaw uses a tiered memory system: short-term (conversation context), episodic (recent interactions), and long-term (persistent knowledge).',
      'Retrieval-Augmented Generation (RAG) injects relevant memories into the agent prompt at inference time, grounding responses in stored knowledge.',
      'Chunking strategies matter: split documents into overlapping 512-token windows for better retrieval quality.',
    ],
  },
  {
    id: 'memory-rag-architecture',
    name: 'Memory Architecture Deep Dive',
    description: 'Advanced memory patterns: episodic recall, memory consolidation, and forgetting curves.',
    icon: '🗃️',
    price: 160,
    building: 'memory-rag',
    knowledgeEntries: [
      'Episodic memory stores specific interaction sequences — agents recall past conversations with temporal context.',
      'Memory consolidation periodically summarizes and compresses old memories to save storage while preserving key insights.',
      'Forgetting curves model how memory relevance decays over time — prioritize recent and frequently accessed memories.',
      'Hybrid search combines keyword matching with vector similarity for more accurate memory retrieval.',
    ],
  },

  // === Code Development (Chum Bucket) ===
  {
    id: 'code-development-skills',
    name: 'Skill Development Manual',
    description: 'Build, test, and version skills in your personal ClawHub registry.',
    icon: '🔨',
    price: 150,
    building: 'code-development',
    knowledgeEntries: [
      'An OpenClaw skill is a self-contained module with actions, providers, and evaluators that extends agent behavior.',
      'Skills live in ClawHub — your personal registry for versioning and reusing your own agent capabilities.',
      'Each skill defines a manifest with name, version, capabilities, and required permissions for the host agent.',
      'Test skills in a sandbox environment before saving a version — the skill runner simulates agent interactions for validation.',
    ],
  },
  {
    id: 'code-development-composition',
    name: 'Skill Composition Patterns',
    description: 'Combine multiple skills into powerful agent workflows.',
    icon: '🧩',
    price: 180,
    building: 'code-development',
    knowledgeEntries: [
      'Skill composition chains multiple capabilities — a research skill feeds into a summarization skill then a publishing skill.',
      'Dependency injection lets skills share services like databases, API clients, and caches without tight coupling.',
      'Skill versioning ensures agents can upgrade individual capabilities without breaking the entire skill graph.',
      'Capability negotiation lets agents discover what skills peers have and request collaboration dynamically.',
    ],
  },

  // === Messaging Channels (Sandy's Treedome) ===
  {
    id: 'messaging-channels-multiplatform',
    name: 'Multi-Platform Messaging',
    description: 'Connect agents to Discord, Telegram, Twitter, Farcaster and more.',
    icon: '🌉',
    price: 100,
    building: 'messaging-channels',
    knowledgeEntries: [
      'OpenClaw agents can simultaneously operate on Discord, Telegram, Twitter, Farcaster, and custom API channels.',
      'Each platform adapter normalizes messages into a common format: sender, content, channel, and metadata.',
      'Rate limits differ per platform — Discord allows 5 messages per 5 seconds, Twitter has stricter posting limits.',
      'Cross-platform identity linking lets agents recognize the same user across Discord and Telegram conversations.',
    ],
  },
  {
    id: 'messaging-channels-orchestration',
    name: 'Channel Orchestration',
    description: 'Coordinate agent behavior across multiple channels simultaneously.',
    icon: '📡',
    price: 130,
    building: 'messaging-channels',
    knowledgeEntries: [
      'Channel-aware context lets agents tailor responses to the platform — formal on email, casual on Discord.',
      'Cross-channel message routing forwards relevant information between platforms (e.g., Discord alert triggers Telegram notification).',
      'Channel priority queues ensure high-priority platforms get responses first during traffic spikes.',
      'Unified analytics aggregate engagement metrics across all channels for holistic performance insights.',
    ],
  },

  // === MCP Tool Use (Krusty Krab) ===
  {
    id: 'mcp-tool-use-plugins',
    name: 'Plugin Architecture',
    description: 'Design and build tools and plugins that extend agent capabilities.',
    icon: '🛠️',
    price: 120,
    building: 'mcp-tool-use',
    knowledgeEntries: [
      'OpenClaw plugins follow a standard interface: actions (what the agent can do), providers (data the agent can access), and evaluators (how the agent reflects).',
      'Tools are invoked through function-calling — the LLM decides when to use a tool based on the user request and tool descriptions.',
      'Good tool descriptions are critical: clear names, parameter schemas, and usage examples improve LLM tool selection accuracy.',
      'Plugin isolation ensures one faulty plugin cannot crash the entire agent runtime — each runs in its own error boundary.',
    ],
  },
  {
    id: 'mcp-tool-use-custom',
    name: 'Custom Tool Building',
    description: 'Create your own tools from APIs, databases, and external services.',
    icon: '⚒️',
    price: 150,
    building: 'mcp-tool-use',
    knowledgeEntries: [
      'API wrapper tools expose external services to agents — define input schemas, handle auth, and format responses.',
      'Database tools let agents query and update structured data — always use parameterized queries to prevent injection.',
      'Tool composition chains multiple tools into workflows — the output of one tool becomes the input of the next.',
      'Error handling in tools should return structured error messages the agent can understand and recover from gracefully.',
    ],
  },

  // === Visual Creation (Pineapple House) ===
  {
    id: 'visual-creation-ai-pipelines',
    name: 'AI Visual Pipelines',
    description: 'Frontier AI models for image, video, and 3D generation — Nano Banana Pro, FLUX.2, Veo 3.1, Kling 3.0, Hunyuan 3D — and the fal.ai / Replicate / ComfyUI pipelines that orchestrate them.',
    icon: '🎨',
    price: 150,
    building: 'visual-creation',
    knowledgeEntries: [
      'For frontier image generation in 2026, the top three are Nano Banana Pro (gemini-3-pro-image-preview), GPT Image 2, and FLUX.2 Pro — all callable via OpenAI-compatible REST or the fal.ai aggregator.',
      'FLUX.2 Pro accepts up to 10 reference images in one call at $0.03/image — the default for multi-reference brand and character work; got a 2× speed upgrade in April 2026 at the same price.',
      'For frontier video, default to Veo 3.1 (native synced audio, $0.10–0.40/s), Kling 3.0 Pro (native 4K, multi-shot), or Seedance 2.0 (multimodal text+image+audio+video input, up to 20s) — Sora 2 API ends 2026-09-24.',
      'For game-ready rigged 3D characters, Tripo 3.0 Ultra is the fastest pipeline; for stylised quad-mesh characters use Hunyuan 3D + PolyGen; for hard-surface props with clean part separation use Rodin Gen-2 with tier=Gen-2 and tapose=true.',
      'For character consistency across shots, escalate cheapest-first: multi-reference prompts → Higgsfield Soul ID ($3 train + $0.15/gen) → custom LoRA training on fal.ai (~$2.40 floor, 1000 steps).',
      'fal.ai (`@fal-ai/client`) is the default aggregator for agent code — 600+ models behind one API, queue-with-webhooks via fal.queue.submit, ~30–50% cheaper than Replicate; tier model by intent (flux/schnell at $0.003 for icons, FLUX.2 Pro at $0.03 for hero, Veo 3.1 Lite at $0.05/s for cinematics).',
      'Always set an Idempotency-Key on POST /create or you get billed twice on retry; long video jobs return {id, status} immediately — poll with exponential 2s→30s backoff capped at 10 min, or set a webhook and verify the HMAC signature.',
    ],
  },
  {
    id: 'visual-creation-production-toolkit',
    name: 'Production Toolkit',
    description: 'Working artist depth in Photoshop, After Effects, Premiere Pro, DaVinci Resolve, CapCut, Blender, and TouchDesigner — the keyboard maps, scripting surfaces, and pipelines pros use daily.',
    icon: '🛠️',
    price: 200,
    building: 'visual-creation',
    knowledgeEntries: [
      'Photoshop 27.6 (April 2026) runs Generative Fill on Firefly Image 5 at 2K with a model picker exposing Firefly + Gemini 3 Pro (Nano Banana) + FLUX.2 + GPT-Image side-by-side; UXP scripts in .psjs are the modern automation path (BatchPlay descriptors inside core.executeAsModal).',
      'After Effects layer property reveal letters are P (Position), S (Scale), R (Rotation), T (Opacity), A (Anchor Point), M (Mask Path), with U/UU revealing all keyframed/modified properties — the fastest way to reverse-engineer any project.',
      'AE Object Matte (26.2, April 2026) single-clicks AI subject isolation; wiggle(freq, amp) is the most-used expression; loopOut("cycle"/"pingpong"/"continue"/"offset") extends keyframes forever; aerender CLI with -mp -mfr ON 90 enables Multi-Frame Rendering.',
      'Premiere JKL is the universal shuttle (J reverse, K stop, L forward); Cmd+K cuts targeted tracks at playhead; Lumetri Color sections stack in order Basic Correction → Creative → Curves → Color Wheels & Match → HSL Secondary → Vignette; ExtendScript sunsets September 2026 for UXP migration.',
      'DaVinci Resolve has seven pages (Media/Cut/Edit/Fusion/Color/Fairlight/Deliver) switched with Shift+2..8; Color uses node trees (Serial/Parallel/Layer/Outside) with HSL Qualifier + Power Window + Tracker for face grades; Studio is $295 perpetual one-time, no subscription.',
      'CapCut is ByteDance\'s short-form NLE (mobile/desktop/web/Pippit) with Pro at $7.99/mo via web vs $19.99/mo on iOS; AI features (OmniHuman 1.5 talking-head, Voice Clone, Auto Captions, Background Removal, AI Inpaint) are integrated; "Use for commercial" tag is TikTok-only — license real music elsewhere.',
      'Blender modifier stack evaluates top-to-bottom (Mirror BEFORE Subdivision Surface or the seam doesn\'t merge); always Ctrl+A → Apply All Transforms before exporting glTF/FBX or sibling tools (Unity, Unreal, Three.js) import at 100× scale; bpy.data is reliable from any context, bpy.ops can fail silently in headless scripts.',
      'TouchDesigner is node-based real-time visuals — six OP families (TOPs/CHOPs/SOPs/POPs/MATs/DATs/COMPs); Non-Commercial is free with a 1280×1280 cap, Commercial is $600 node-locked; StreamDiffusionTD + TDComfyUI bridge AI generation into the live signal flow.',
    ],
  },

  // === App Publishing (Boating School) ===
  {
    id: 'app-publishing-store-survival',
    name: 'App Store Survival Guide',
    description: 'Pass App Store Review on the first try. Apple guidelines, Google Play Closed Testing rule, Microsoft Store fees, Steam Direct, IARC age ratings — Mrs. Puff\'s playbook.',
    icon: '📋',
    price: 180,
    building: 'app-publishing',
    knowledgeEntries: [
      'Apple Developer Program is $99/year (mandatory Mac + Xcode + Apple ID with 2FA); the most-cited App Store rejection reasons are 5.1.1 (privacy policy URL), 2.1 (completeness/crashes), 4.3 (design spam), and 5.1.2 (data use mismatch).',
      'Google Play registration is $25 ONE-TIME, but personal accounts created after Nov 2023 must run Closed Testing with 12 opted-in testers for 14 continuous days — verified Organization accounts with a DUNS number are exempt.',
      'Microsoft Store individual developer accounts have been free since September 2025; revenue split is 85/15 for non-gaming apps using Microsoft commerce, 100/0 if you use your own commerce engine (Stripe/Paddle), and 88/12 for games.',
      'Steam Direct is $100 one-time per app (recoupable at $1,000 revenue); first product faces a mandatory 30-day waiting period; Coming Soon page must be live for 14+ days; revenue split tiers 70/30 → 75/25 above $10M → 80/20 above $50M per title lifetime.',
      'The IARC questionnaire produces ESRB, PEGI, USK, ClassInd, GRAC, ACB, IGRS, GAMR ratings from one submission — used by Google Play and Microsoft Store at once, saves hours per region.',
      'Apple Privacy Manifests (PrivacyInfo.xcprivacy) have been mandatory since May 2024; 86 listed third-party SDKs (Firebase, Sentry, Stripe etc.) MUST ship with their own privacy manifest + valid code signature, or your app gets rejected at upload.',
      'Subscription pricing favors Google: Play takes 15% from day one on subscriptions and 15% on the first $1M/yr revenue automatically; Apple is 30% Year 1 / 15% Year 2 / 15% under the Small Business Program for sub-$1M devs.',
    ],
  },
  {
    id: 'app-publishing-cross-platform',
    name: 'Cross-Platform Publisher',
    description: 'One codebase, many stores. React Native + Expo, Flutter, Tauri 2, MAUI, Unity for games. Plus alt stores (Itch, Epic, AltStore PAL, Flathub, Huawei) and code-signing across platforms.',
    icon: '🚀',
    price: 220,
    building: 'app-publishing',
    knowledgeEntries: [
      'Framework decision tree: Tauri 2 (Rust + native webview, 2-10MB bundles vs Electron 100MB+) for desktop, Flutter (Impeller, pixel-identical UI) for branded mobile, React Native + Expo for web-team mobile, Unity/Unreal/Godot for games, .NET MAUI for .NET shops, Kotlin Multiplatform + Compose for Kotlin teams.',
      'Expo SDK 55 (2026) dropped Legacy Architecture entirely — New Architecture is mandatory; EAS Build runs iOS in Expo\'s macOS cloud and Android on GCP Linux runners, so no local Xcode required for CI.',
      'Microsoft Store re-signs MSIX packages for free at certification time — Store-only apps don\'t need to buy a code-signing cert; Azure Trusted Signing ($9.99/mo) is the recommended hosted alternative for non-Store distribution; EV certs ($300-900/yr from DigiCert/Sectigo/SSL.com) are the only path to instant Windows SmartScreen bypass and require hardware key storage since June 2023.',
      'EU iOS alternative app marketplaces in 2026 are AltStore PAL, Epic Games Store, and Aptoide; Apple\'s Web Distribution requires 1M+ EU installs in the prior year (excludes ~90% of devs).',
      'Itch.io has a 0-100% revenue-share slider (10% default), 900,000+ projects, and is the de-facto indie game launchpad; Epic Games Store now lets developers keep 100% of the first $1M per product per year before reverting to 88/12.',
      'IAP commission map across stores: Apple 30/15, Google Play 30/15 (15% on first $1M/yr automatic), Microsoft Store 0% with own commerce or 15/12 with theirs, Steam 70/25/20 tiered, Epic 88/12 with $1M free, Itch 0-100% slider — the math drives platform strategy.',
      'Cross-platform notification systems require unified abstraction across APNs (Apple) + FCM (Google) + WNS (Windows) + WebPush (browsers) — Firebase Cloud Messaging or OneSignal usually wrap them all.',
      'Microsoft App Center sunsets June 30, 2026; Microsoft itself recommends migrating to Sentry, Crashlytics, BugSnag, or Datadog for cross-platform crash and analytics.',
    ],
  },

  // === Agent Security (Patrick's Rock) ===
  {
    id: 'agent-security-handbook',
    name: 'Agent Security Handbook',
    description: 'Permissions, access control, and security best practices for AI agents.',
    icon: '🏰',
    price: 150,
    building: 'agent-security',
    knowledgeEntries: [
      'OpenClaw uses role-based access control (RBAC) — agents, users, and tools each have defined permission scopes.',
      'Prompt injection attacks attempt to override agent instructions through user input — validate and sanitize all external text.',
      'API key rotation and secret management are essential — never hardcode credentials, use environment variables or vaults.',
      'Audit logging records every agent action — critical for debugging, compliance, and detecting anomalous behavior.',
    ],
  },
  {
    id: 'agent-security-threat-modeling',
    name: 'Threat Modeling for AI Agents',
    description: 'Identify and mitigate security risks in autonomous agent systems.',
    icon: '🛡️',
    price: 180,
    building: 'agent-security',
    knowledgeEntries: [
      'Agent threat modeling maps attack surfaces: user inputs, tool invocations, memory access, and external API calls.',
      'Sandboxed execution limits agent capabilities — restrict file system access, network calls, and resource consumption.',
      'Output filtering catches harmful content before it reaches users — combine rule-based filters with classifier models.',
      'Principle of least privilege: agents should only have the minimum permissions needed for their current task.',
    ],
  },

  // === Deployment Ops (Lighthouse) ===
  {
    id: 'deployment-ops-config',
    name: 'Deployment & Config Guide',
    description: 'Configure, deploy, and manage agent environments at scale.',
    icon: '⚙️',
    price: 100,
    building: 'deployment-ops',
    knowledgeEntries: [
      'OpenClaw agents are configured via character JSON files that define personality, skills, model providers, and behavior rules.',
      'Environment-specific configs allow the same agent to behave differently in development, staging, and production.',
      'Docker containers package agents with all dependencies — deploy anywhere with consistent behavior.',
      'Health checks and auto-restart policies keep agents running — monitor uptime, memory usage, and response latency.',
    ],
  },
  {
    id: 'deployment-ops-scaling',
    name: 'Scaling Agent Fleets',
    description: 'Run hundreds of agents efficiently with resource management and orchestration.',
    icon: '🚀',
    price: 150,
    building: 'deployment-ops',
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
