/** Buildings that offer services (knowledge, tools, etc.) */
export const SHOP_BUILDINGS = [
  'cron-hub',
  'webhook-gateway',
  'memory-vault',
  'skill-forge',
  'channel-bridge',
  'tool-workshop',
  'canvas-studio',
  'voice-tower',
  'security-fortress',
  'config-citadel',
] as const;

export type ShopBuildingId = (typeof SHOP_BUILDINGS)[number];

/** Check if a building is a shop (has items for sale) */
export function isShopBuilding(buildingId: string): boolean {
  return (SHOP_BUILDINGS as readonly string[]).includes(buildingId);
}

/** Building canon labels — SpongeBob landmark names, with skill category underneath.
 *  label   → SpongeBob canon (e.g. "Chum Bucket", "Pineapple House")
 *  focus   → detailed skill description (used by NPC prompts / location context)
 *  category → short skill-area label rendered under the canon name in the 3D UI */
export const BUILDING_OPENCLAW_THEMES: Record<string, { label: string; focus: string; category: string }> = {
  'cron-hub': { label: 'Downtown Building', focus: 'cron jobs, task queues, workflow orchestration, CI/CD pipelines, and scheduled automation', category: 'Automation & Workflows' },
  'webhook-gateway': { label: 'Salty Spitoon', focus: 'REST APIs, GraphQL, webhooks, OAuth, rate limiting, and system integrations', category: 'APIs & Integrations' },
  'memory-vault': { label: "Squidward's House", focus: 'RAG pipelines, vector databases, text embeddings, semantic search, and context management', category: 'Memory & Knowledge' },
  'skill-forge': { label: 'Chum Bucket', focus: 'code generation, debugging, testing, git workflows, and containerized development', category: 'Code & Development' },
  'channel-bridge': { label: "Sandy's Treedome", focus: 'email automation, Slack, Discord, Telegram bots, and multi-channel messaging', category: 'Communication' },
  'tool-workshop': { label: 'Krusty Krab', focus: 'function calling, MCP servers, tool chains, agentic loops, and custom tool development', category: 'Tool Use & MCP' },
  'canvas-studio': { label: 'Pineapple House', focus: 'AI image (Nano Banana Pro, FLUX.2, GPT Image 2), AI video (Veo 3.1, Kling 3.0, Seedance 2.0), AI 3D (Hunyuan 3D, Tripo, Rodin), agentic pipelines (fal.ai, Replicate, ComfyUI), real-time interactive visuals in TouchDesigner, Adobe Photoshop / After Effects / Premiere Pro deep controls + UXP / ExtendScript / aerender / AME automation, DaVinci Resolve (seven-page architecture, node-based color grading, Fusion compositing, Fairlight DAW, $295 Studio one-time perpetual), CapCut (mobile/desktop/web/Pippit, AI Auto Captions / Background Removal / Voice Clone / OmniHuman 1.5 / Dreamina Seedance 2.0), and Blender (Geometry Nodes, Cycles + EEVEE Next, rigging, sculpting, Python bpy, headless rendering)', category: 'Visual Creation' },
  'voice-tower': { label: 'Boating School', focus: 'web search APIs, fact-checking, summarization, structured outputs, and research automation', category: 'Research & Analysis' },
  'security-fortress': { label: "Patrick's Rock", focus: 'Solana development, wallets, DeFi protocols, smart contracts, and on-chain data', category: 'Crypto & Web3' },
  'config-citadel': { label: 'Lighthouse', focus: 'project management APIs, invoicing, document automation, scheduling, and deployment config', category: 'Business & Productivity' },
};
