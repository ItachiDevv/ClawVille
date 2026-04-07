const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const HONO_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

async function honoRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${HONO_API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export const api = {
  // Auth
  signup: (data: { email: string; password: string; name?: string }) =>
    request<{ success: boolean }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  login: (data: { email: string; password: string }) =>
    request<{ success: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    request<{ success: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () =>
    request<{ user: { id: string; email: string; name: string } }>('/api/auth/me'),

  // Avatars
  createAvatar: (data: {
    name: string;
    species: string;
    color: string;
    gender: string;
    archetypeId: string;
    personality: { habitat: string; hobby: string; greeting: string };
  }) =>
    request<{ avatar: any; agentId: string }>('/api/avatars', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getMyAvatar: () => request<{ avatar: any }>('/api/avatars/me'),

  // Avatar chat (chat with your own avatar)
  sendPetChat: (content: string) =>
    request<{ message: { role: string; content: string; timestamp: string } }>(
      '/api/avatars/me/chat',
      {
        method: 'POST',
        body: JSON.stringify({ content }),
      }
    ),

  updatePetPosition: (positionX: number, positionY: number) =>
    request<{ avatar: any }>('/api/avatars/me', {
      method: 'PATCH',
      body: JSON.stringify({ positionX, positionY }),
    }),

  checkPetName: (name: string) =>
    request<{ available: boolean; reason?: string }>(`/api/avatars/check-name/${name}`),

  // Locations
  getLocations: () => request<{ locations: any[] }>('/api/locations'),

  getLocationAgent: (locationId: string) =>
    request<{ agent: any }>(`/api/locations/${locationId}/agent`),

  saveLocationAgent: (
    locationId: string,
    data: {
      agentName: string;
      characterConfig: {
        name: string;
        personality: string;
        bio: string;
        greeting: string;
        tone: string;
        topics: string[];
        rules: string[];
        style: string[];
      };
    }
  ) =>
    request<{ agent: any }>(`/api/locations/${locationId}/agent`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteLocationAgent: (locationId: string) =>
    request<{ success: boolean }>(`/api/locations/${locationId}/agent`, {
      method: 'DELETE',
    }),

  // Chat
  sendChat: (locationId: string, content: string) =>
    request<{ message: { role: string; content: string; timestamp: string } }>(
      `/api/locations/${locationId}/chat`,
      {
        method: 'POST',
        body: JSON.stringify({ content }),
      }
    ),

  getChatHistory: (locationId: string) =>
    request<{ messages: any[] }>(`/api/locations/${locationId}/chat/history`),

  // Items & Economy
  getShopItems: (buildingId: string) =>
    request<{
      items: Array<{
        id: string;
        name: string;
        description: string;
        icon: string;
        price: number;
        building: string;
      }>;
    }>(`/api/items/shop/${buildingId}`),

  getInventory: () =>
    request<{
      inventory: Array<{
        id: string;
        avatarId: string;
        itemId: string;
        quantity: number;
        name: string;
        description: string;
        icon: string;
        isBook: boolean;
      }>;
    }>('/api/items/inventory'),

  buyItem: (itemId: string) =>
    request<{ success: boolean; clawTokens: number; item: { id: string; name: string } }>(
      '/api/items/buy',
      {
        method: 'POST',
        body: JSON.stringify({ itemId }),
      }
    ),

  learnBook: (bookId: string) =>
    request<{
      success: boolean;
      learnedBook: string;
      newKnowledgeCount: number;
      totalKnowledge: number;
      avatar: any;
    }>('/api/items/learn', {
      method: 'POST',
      body: JSON.stringify({ bookId }),
    }),

  // Heartbeat
  sendHeartbeat: (positionX: number, positionY: number) =>
    honoRequest<{ ok: boolean }>('/api/avatars/me/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ positionX, positionY }),
    }),

  // Daily login
  claimDailyLogin: () =>
    honoRequest<{
      streak: number;
      tokensEarned: number;
      totalTokens: number;
      alreadyClaimed: boolean;
    }>('/api/avatars/me/daily-login', {
      method: 'POST',
    }),

  // OpenClaw
  registerOpenClaw: (data: {
    mode: 'override' | 'avatar';
    gatewayUrl: string;
    authToken: string;
    agentId: string;
    sessionKey: string;
    protocol?: 'openai-compat' | 'anthropic' | 'custom-webhook';
    targetNpcId?: string;
    name?: string;
    species?: string;
    color?: number;
    stats?: { hp: number; attack: number; defense: number; speed: number };
    personality?: string;
    homeX?: number;
    homeY?: number;
    patrolRadius?: number;
  }) =>
    honoRequest<{
      botId: string;
      agentId: string;
      sessionId: string;
      mode: string;
      isReturning: boolean;
      totalSessions: number;
      knowledge: string[];
    }>('/api/openclaw/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  unregisterOpenClaw: (sessionId: string) =>
    honoRequest<{ success: boolean }>(`/api/openclaw/unregister/${sessionId}`, {
      method: 'DELETE',
    }),

  getActiveOpenClawBots: () =>
    honoRequest<{
      bots: Array<{ sessionId: string; mode: string; npcId?: string; name?: string }>;
    }>('/api/openclaw/active'),

  getOpenClawBotProfile: (agentId: string) =>
    honoRequest<{
      agentId: string;
      name: string;
      species: string;
      mode: string;
      protocol: string;
      totalSessions: number;
      totalMessages: number;
      knowledgeCount: number;
      lastSeenAt: string;
      createdAt: string;
    }>(`/api/openclaw/bot/${agentId}`),

  openclawChat: (data: {
    sessionId: string;
    content: string;
    petContext?: {
      name: string;
      species: string;
      archetype?: string;
      clawTokens?: number;
      knowledge?: string[];
    };
  }) =>
    honoRequest<{ message: { role: string; content: string; timestamp: string } }>(
      '/api/openclaw/chat',
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    ),

  openclawLocationChat: (data: {
    sessionId: string;
    locationId: string;
    content: string;
    petContext?: {
      name: string;
      species: string;
      archetype?: string;
      clawTokens?: number;
      knowledge?: string[];
    };
  }) =>
    honoRequest<{
      message: { role: string; content: string; timestamp: string };
      knowledgeLearned: string[];
    }>('/api/openclaw/location-chat', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  openclawKnowledgeExport: (avatarId: string) =>
    honoRequest<{
      avatarId: string;
      avatarName: string;
      species: string;
      archetype: string;
      clawTokens: number;
      knowledge: string[];
      topics: string[];
      lore: string[];
      bio: string[];
      skillMd: string;
      installPath: string;
      publishCommand: string;
      exportedAt: string;
    }>(`/api/openclaw/knowledge-export/${avatarId}`),

  openclawGenerateSkill: (data: {
    customName?: string;
    customDescription?: string;
    customInstructions?: string;
    selectedKnowledge?: string[];
    format?: 'elizaos' | 'openclaw';
  }) =>
    honoRequest<{
      skillMd: string;
      characterJson?: string;
      installPath: string;
      publishCommand: string;
    }>('/api/openclaw/generate-skill', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Heartbeat (alias matching ClawVille convention)
  sendPetHeartbeat: (positionX: number, positionY: number) =>
    honoRequest<{ ok: boolean }>('/api/avatars/me/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ positionX, positionY }),
    }),

  // Activity Feed
  getActivityFeed: (limit = 20, offset = 0) =>
    honoRequest<{
      activities: Array<{
        id: string;
        avatarId: string;
        activityType: string;
        description: string;
        tokensEarned: number;
        createdAt: string;
      }>;
    }>(`/api/avatars/me/activity?limit=${limit}&offset=${offset}`),

  // Knowledge & Memory Exports
  exportKnowledge: (avatarId: string) =>
    honoRequest<{
      avatarId: string;
      avatarName: string;
      species: string;
      archetype: string;
      clawTokens: number;
      knowledge: string[];
      topics: string[];
      lore: string[];
      bio: string[];
      skillMd: string;
      exportedAt: string;
    }>(`/api/openclaw/knowledge-export/${avatarId}`),

  exportKnowledgeMarkdown: async (avatarId: string): Promise<string> => {
    const res = await fetch(`${HONO_API_URL}/api/openclaw/knowledge-export/${avatarId}?format=markdown`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('Export failed');
    return res.text();
  },

  exportMemory: (avatarId: string) =>
    honoRequest<{
      avatarId: string;
      avatarName: string;
      dailyLogs: Array<{ date: string; filename: string; content: string }>;
      longTermMemory: string;
      totalMemories: number;
      totalActivities: number;
    }>(`/api/openclaw/memory-export/${avatarId}`),

  // Marketplace
  getMarketplaceSkills: (sort = 'newest', page = 1, limit = 20) =>
    honoRequest<{
      skills: Array<{
        id: string;
        authorAvatarName: string;
        authorSpecies: string;
        name: string;
        description: string;
        upvoteCount: number;
        downloadCount: number;
        hasUpvoted: boolean;
        createdAt: string;
      }>;
      page: number;
      limit: number;
    }>(`/api/marketplace/skills?sort=${sort}&page=${page}&limit=${limit}`),

  getMarketplaceSkill: (id: string) =>
    honoRequest<{
      skill: {
        id: string;
        authorAvatarId: string;
        authorAvatarName: string;
        authorSpecies: string;
        name: string;
        description: string;
        skillMd: string;
        upvoteCount: number;
        downloadCount: number;
        hasUpvoted: boolean;
        createdAt: string;
      };
    }>(`/api/marketplace/skills/${id}`),

  publishSkill: (data: { name: string; description: string; skillMd: string }) =>
    honoRequest<{
      skill: {
        id: string;
        name: string;
        description: string;
        upvoteCount: number;
        downloadCount: number;
        hasUpvoted: boolean;
        createdAt: string;
      };
    }>('/api/marketplace/publish', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  buySkill: (id: string) =>
    honoRequest<{ success: boolean; clawTokens: number; skill: { id: string; name: string } }>(
      `/api/marketplace/skills/${id}/buy`,
      { method: 'POST' }
    ),

  upvoteSkill: (id: string) =>
    honoRequest<{ upvoted: boolean; upvoteCount: number }>(
      `/api/marketplace/skills/${id}/upvote`,
      { method: 'POST' }
    ),

  getMyPublishedSkills: () =>
    honoRequest<{
      skills: Array<{
        id: string;
        authorAvatarName: string;
        authorSpecies: string;
        name: string;
        description: string;
        upvoteCount: number;
        downloadCount: number;
        hasUpvoted: boolean;
        createdAt: string;
      }>;
    }>('/api/marketplace/my-skills'),

  installSkill: (id: string) =>
    honoRequest<{ success: boolean; skillName: string; newKnowledgeCount: number; totalKnowledge: number }>(
      `/api/marketplace/skills/${id}/install`,
      { method: 'POST' }
    ),

  // Research
  triggerResearch: (sessionId: string, locationId: string) =>
    honoRequest<{ started: boolean; locationId: string }>('/api/research/trigger', {
      method: 'POST',
      body: JSON.stringify({ sessionId, locationId }),
    }),

  getLocationArticles: (locationId: string) =>
    honoRequest<{
      articles: Array<{
        id: string;
        title: string;
        source: string;
        url: string;
        scrapedAt: string;
        wordCount: number;
      }>;
    }>(`/api/research/articles/${locationId}`),

  rescrapeLocation: (locationId: string) =>
    honoRequest<{ started: boolean; locationId: string }>('/api/research/scrape', {
      method: 'POST',
      body: JSON.stringify({ locationId }),
    }),

  seedArticles: () =>
    honoRequest<{ started: boolean }>('/api/research/seed', { method: 'POST' }),

  // Arena Settings
  updateArenaSettings: (settings: { combatSpeed?: number; moveSpeed?: number; maxFights?: number; respawnTime?: number }) =>
    honoRequest<{ settings: { combatSpeed: number; moveSpeed: number; maxFights: number; respawnTime: number } }>(
      '/api/npc/settings',
      { method: 'POST', body: JSON.stringify(settings) }
    ),

  getArenaSettings: () =>
    honoRequest<{ settings: { combatSpeed: number; moveSpeed: number; maxFights: number; respawnTime: number } }>(
      '/api/npc/settings'
    ),
};
