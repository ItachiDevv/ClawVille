export interface MiladyGatewayConfig {
  baseUrl: string;
  authToken: string;
  timeoutMs?: number;
  enabled?: boolean;
}

export interface MiladySkillDefinition {
  skillId: string;
  name: string;
  description: string;
  category: string;
  buildingId: string;
  requiredBooks: number;
}

/** Maps each building to its Milady skill definition (one skill per building) */
export const BUILDING_MILADY_SKILLS: Record<string, MiladySkillDefinition> = {
  'cron-automation': {
    skillId: 'clawville-automation',
    name: 'Automation & Scheduling',
    description: 'Cron jobs, task queues, workflow orchestration, and scheduled automation',
    category: 'Automation & Workflows',
    buildingId: 'cron-automation',
    requiredBooks: 2,
  },
  'api-integrations': {
    skillId: 'clawville-apis',
    name: 'APIs & Integrations',
    description: 'REST APIs, GraphQL, webhooks, OAuth, and system integrations',
    category: 'APIs & Integrations',
    buildingId: 'api-integrations',
    requiredBooks: 2,
  },
  'memory-rag': {
    skillId: 'clawville-memory',
    name: 'Memory & Knowledge',
    description: 'RAG pipelines, vector databases, text embeddings, and semantic search',
    category: 'Memory & Knowledge',
    buildingId: 'memory-rag',
    requiredBooks: 2,
  },
  'code-development': {
    skillId: 'clawville-code',
    name: 'Code & Development',
    description: 'Code generation, debugging, testing, git workflows, and containerized dev',
    category: 'Code & Development',
    buildingId: 'code-development',
    requiredBooks: 2,
  },
  'messaging-channels': {
    skillId: 'clawville-comms',
    name: 'Communication',
    description: 'Email automation, Slack, Discord, Telegram bots, and multi-channel messaging',
    category: 'Communication',
    buildingId: 'messaging-channels',
    requiredBooks: 2,
  },
  'mcp-tool-use': {
    skillId: 'clawville-tools',
    name: 'Tool Use & MCP',
    description: 'Function calling, MCP servers, tool chains, agentic loops, and custom tools',
    category: 'Tool Use & MCP',
    buildingId: 'mcp-tool-use',
    requiredBooks: 2,
  },
  'visual-creation': {
    skillId: 'clawville-visual',
    name: 'Visual Creation',
    description: 'AI image / video / 3D generation, agentic pipelines, TouchDesigner, Photoshop, After Effects, Premiere Pro, DaVinci Resolve, CapCut, Blender',
    category: 'Visual Creation',
    buildingId: 'visual-creation',
    requiredBooks: 2,
  },
  'app-publishing': {
    skillId: 'clawville-publishing',
    name: 'App Publishing',
    description: 'Shipping to Apple App Store, Google Play, Microsoft Store, Steam, alt stores, cross-platform frameworks, and code signing',
    category: 'App Publishing',
    buildingId: 'app-publishing',
    requiredBooks: 2,
  },
  'agent-security': {
    skillId: 'clawville-security',
    name: 'Agent Security',
    description: 'Agent permissions, RBAC, prompt injection defense, sandboxed execution, and threat modeling',
    category: 'Security',
    buildingId: 'agent-security',
    requiredBooks: 2,
  },
  'deployment-ops': {
    skillId: 'clawville-ops',
    name: 'Deployment & Ops',
    description: 'Agent fleet management, blue-green deployments, Docker containerization, observability, and scaling',
    category: 'Deployment & Ops',
    buildingId: 'deployment-ops',
    requiredBooks: 2,
  },
};
