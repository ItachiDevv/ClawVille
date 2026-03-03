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

  // Pets
  createPet: (data: {
    name: string;
    species: string;
    color: string;
    gender: string;
    archetypeId: string;
    personality: { habitat: string; hobby: string; greeting: string };
  }) =>
    request<{ pet: any; agentId: string }>('/api/pets', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getMyPet: () => request<{ pet: any }>('/api/pets/me'),

  // Pet chat (chat with your own pet)
  sendPetChat: (content: string) =>
    request<{ message: { role: string; content: string; timestamp: string } }>(
      '/api/pets/me/chat',
      {
        method: 'POST',
        body: JSON.stringify({ content }),
      }
    ),

  updatePetPosition: (positionX: number, positionY: number) =>
    request<{ pet: any }>('/api/pets/me', {
      method: 'PATCH',
      body: JSON.stringify({ positionX, positionY }),
    }),

  checkPetName: (name: string) =>
    request<{ available: boolean; reason?: string }>(`/api/pets/check-name/${name}`),

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
        petId: string;
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
      pet: any;
    }>('/api/items/learn', {
      method: 'POST',
      body: JSON.stringify({ bookId }),
    }),

  // Heartbeat
  sendHeartbeat: (positionX: number, positionY: number) =>
    honoRequest<{ ok: boolean }>('/api/pets/me/heartbeat', {
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
    }>('/api/pets/me/daily-login', {
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

  openclawKnowledgeExport: (petId: string) =>
    honoRequest<{
      petId: string;
      petName: string;
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
    }>(`/api/openclaw/knowledge-export/${petId}`),

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
};
