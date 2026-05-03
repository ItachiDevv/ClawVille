/** Buildings that offer services (knowledge, tools, etc.) */
export const SHOP_BUILDINGS = [
  'cron-automation',
  'api-integrations',
  'memory-rag',
  'code-development',
  'messaging-channels',
  'mcp-tool-use',
  'visual-creation',
  'app-publishing',
  'agent-security',
  'deployment-ops',
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
  'cron-automation': { label: 'Downtown Building', focus: 'cron jobs, task queues, workflow orchestration, CI/CD pipelines, and scheduled automation', category: 'Automation & Workflows' },
  'api-integrations': { label: 'Salty Spitoon', focus: 'REST APIs, GraphQL, webhooks, OAuth, rate limiting, and system integrations', category: 'APIs & Integrations' },
  'memory-rag': { label: "Squidward's House", focus: 'RAG pipelines, vector databases, text embeddings, semantic search, and context management', category: 'Memory & Knowledge' },
  'code-development': { label: 'Chum Bucket', focus: 'code generation, debugging, testing, git workflows, and containerized development', category: 'Code & Development' },
  'messaging-channels': { label: "Sandy's Treedome", focus: 'email automation, Slack, Discord, Telegram bots, and multi-channel messaging', category: 'Communication' },
  'mcp-tool-use': { label: 'Krusty Krab', focus: 'function calling, MCP servers, tool chains, agentic loops, and custom tool development', category: 'Tool Use & MCP' },
  'visual-creation': { label: 'Pineapple House', focus: 'AI image (Nano Banana Pro, FLUX.2, GPT Image 2), AI video (Veo 3.1, Kling 3.0, Seedance 2.0), AI 3D (Hunyuan 3D, Tripo, Rodin), agentic pipelines (fal.ai, Replicate, ComfyUI), real-time interactive visuals in TouchDesigner, Adobe Photoshop / After Effects / Premiere Pro deep controls + UXP / ExtendScript / aerender / AME automation, DaVinci Resolve (seven-page architecture, node-based color grading, Fusion compositing, Fairlight DAW, $295 Studio one-time perpetual), CapCut (mobile/desktop/web/Pippit, AI Auto Captions / Background Removal / Voice Clone / OmniHuman 1.5 / Dreamina Seedance 2.0), and Blender (Geometry Nodes, Cycles + EEVEE Next, rigging, sculpting, Python bpy, headless rendering)', category: 'Visual Creation' },
  'app-publishing': { label: 'Boating School', focus: 'shipping apps to Apple App Store ($99/yr, Xcode, StoreKit 2, Privacy Manifests), Google Play ($25 one-time, AAB, 14-day Closed Testing rule), Microsoft Store (free individual, MSIX, WinUI 3, $0/100% own commerce), Steam ($100 Steam Direct, Steamworks SDK, Steam Deck Verified), alt stores (Itch.io, Epic, AltStore PAL, F-Droid, Flathub, Huawei AppGallery), cross-platform frameworks (Tauri 2, Flutter, React Native + Expo, MAUI, KMP), and code signing (EV certs, Azure Trusted Signing, hardware key requirement)', category: 'App Publishing' },
  'agent-security': { label: "Patrick's Rock", focus: 'agent permissions, RBAC, prompt injection defense, sandboxed execution, and threat modeling for autonomous systems', category: 'Security' },
  'deployment-ops': { label: 'Lighthouse', focus: 'agent fleet management, blue-green deployments, Docker containerization, observability dashboards, and scaling agent infrastructure', category: 'Deployment & Ops' },
};
