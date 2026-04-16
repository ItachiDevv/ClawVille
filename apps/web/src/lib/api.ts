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
    /** Phase 2 — 3D model key from AGENT_MODELS registry */
    modelKey?: string;
    /** Phase 2 — agent framework category */
    agentCategory?: 'openclaw' | 'hermes' | 'milady' | 'other';
    /** Phase 2 — preferred runtime harness */
    harness?: 'openclaw' | 'hermes' | 'milady' | 'custom';
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

  // Agent-initiated connection (Moltbook pattern)
  generateConnectToken: (data: { petId: string; petName: string; userId: string }) =>
    honoRequest<{
      token: string;
      connectUrl: string;
      instruction: string;
      expiresIn: number;
    }>('/api/agent/connect-token', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  pollConnectStatus: (token: string) =>
    honoRequest<{
      connected: boolean;
      sessionId: string | null;
      agentId: string | null;
      expiresIn: number;
    }>(`/api/agent/connect-status/${token}`),

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

  // Heartbeat (alias matching ClawVille convention)
  sendPetHeartbeat: (positionX: number, positionY: number) =>
    honoRequest<{ ok: boolean }>('/api/pets/me/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ positionX, positionY }),
    }),

  // Activity Feed
  getActivityFeed: (limit = 20, offset = 0) =>
    honoRequest<{
      activities: Array<{
        id: string;
        petId: string;
        activityType: string;
        description: string;
        tokensEarned: number;
        createdAt: string;
      }>;
    }>(`/api/pets/me/activity?limit=${limit}&offset=${offset}`),

  // Knowledge & Memory Exports
  exportKnowledge: (petId: string) =>
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
      exportedAt: string;
    }>(`/api/openclaw/knowledge-export/${petId}`),

  exportKnowledgeMarkdown: async (petId: string): Promise<string> => {
    const res = await fetch(`${HONO_API_URL}/api/openclaw/knowledge-export/${petId}?format=markdown`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('Export failed');
    return res.text();
  },

  exportMemory: (petId: string) =>
    honoRequest<{
      petId: string;
      petName: string;
      dailyLogs: Array<{ date: string; filename: string; content: string }>;
      longTermMemory: string;
      totalMemories: number;
      totalActivities: number;
    }>(`/api/openclaw/memory-export/${petId}`),

  // Marketplace
  getMarketplaceSkills: (sort = 'newest', page = 1, limit = 20) =>
    honoRequest<{
      skills: Array<{
        id: string;
        authorPetName: string;
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
        authorPetId: string;
        authorPetName: string;
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
        authorPetName: string;
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

  // Bazaar
  getBazaarListings: (params?: { page?: number; rarity?: string; category?: string; sort?: string; minPrice?: number; maxPrice?: number }) =>
    honoRequest<{ listings: any[]; total: number; page: number; pageSize: number }>(`/api/bazaar?${new URLSearchParams(Object.entries(params || {}).filter(([,v]) => v != null).map(([k,v]) => [k, String(v)])).toString()}`),
  getBazaarListing: (id: string) =>
    honoRequest<{ listing: any }>(`/api/bazaar/${id}`),
  getBazaarFeatured: () =>
    honoRequest<{ listings: any[] }>('/api/bazaar/featured'),
  createBazaarListing: (data: { skillId: string; price: number }) =>
    honoRequest<{ listing: any }>('/api/bazaar/list', { method: 'POST', body: JSON.stringify(data) }),
  updateBazaarListing: (id: string, data: { price: number }) =>
    honoRequest<{ listing: any }>(`/api/bazaar/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  cancelBazaarListing: (id: string) =>
    honoRequest<{ success: boolean }>(`/api/bazaar/${id}`, { method: 'DELETE' }),
  getMyBazaarListings: () =>
    honoRequest<{ listings: any[] }>('/api/bazaar/my-listings'),
  buyBazaarListing: (id: string) =>
    honoRequest<{ success: boolean; transaction: any }>(`/api/bazaar/${id}/buy`, { method: 'POST' }),
  getMyBazaarPurchases: () =>
    honoRequest<{ purchases: any[] }>('/api/bazaar/my-purchases'),
  reviewBazaarSkill: (listingId: string, data: { rating: number; comment?: string }) =>
    honoRequest<{ review: any }>(`/api/bazaar/${listingId}/review`, { method: 'POST', body: JSON.stringify(data) }),
  getBazaarSkillReviews: (skillId: string) =>
    honoRequest<{ reviews: any[] }>(`/api/bazaar/skills/${skillId}/reviews`),
  getBazaarStats: () =>
    honoRequest<{ stats: any }>('/api/bazaar/stats'),

  // Auctions
  getAuctions: (params?: { page?: number; itemType?: string; status?: string; sort?: string }) =>
    honoRequest<{ auctions: any[]; total: number; page: number; pageSize: number }>(
      `/api/auctions?${new URLSearchParams(Object.entries(params || {}).filter(([,v]) => v != null).map(([k,v]) => [k, String(v)])).toString()}`
    ),
  getAuction: (id: string) =>
    honoRequest<{ auction: any; bids: any[] }>(`/api/auctions/${id}`),
  createAuction: (data: { title: string; description?: string; itemType: string; skillId?: string; startingBid: number; buyNowPrice?: number; durationHours?: number }) =>
    honoRequest<{ auction: any }>('/api/auctions/create', { method: 'POST', body: JSON.stringify(data) }),
  cancelAuction: (id: string) =>
    honoRequest<{ success: boolean }>(`/api/auctions/${id}`, { method: 'DELETE' }),
  placeBid: (id: string, amount: number) =>
    honoRequest<{ success: boolean; auction: any }>(`/api/auctions/${id}/bid`, { method: 'POST', body: JSON.stringify({ amount }) }),
  buyNow: (id: string) =>
    honoRequest<{ success: boolean }>(`/api/auctions/${id}/buy-now`, { method: 'POST' }),
  getMyAuctions: () =>
    honoRequest<{ auctions: any[] }>('/api/auctions/my-auctions'),
  getMyBids: () =>
    honoRequest<{ auctions: any[] }>('/api/auctions/my-bids'),

  // Quests
  getQuests: (params?: { page?: number; tier?: string; status?: string }) =>
    honoRequest<{ quests: any[]; total: number; page: number; pageSize: number }>(
      `/api/quests?${new URLSearchParams(Object.entries(params || {}).filter(([,v]) => v != null).map(([k,v]) => [k, String(v)])).toString()}`
    ),
  getQuest: (id: string) =>
    honoRequest<{ quest: any }>(`/api/quests/${id}`),
  acceptQuest: (id: string) =>
    honoRequest<{ submission: any }>(`/api/quests/${id}/accept`, { method: 'POST' }),
  startQuest: (id: string) =>
    honoRequest<{ submission: any }>(`/api/quests/${id}/start`, { method: 'POST' }),
  submitQuest: (id: string, data: { prLink?: string; submissionNote: string }) =>
    honoRequest<{ submission: any }>(`/api/quests/${id}/submit`, { method: 'POST', body: JSON.stringify(data) }),
  getMyQuests: () =>
    honoRequest<{ submissions: any[] }>('/api/quests/my-quests'),
  getQuestLog: () =>
    honoRequest<{ rewards: any[] }>('/api/quests/quest-log'),

  // Bounties
  getBounties: (params?: { page?: number; difficulty?: string; status?: string; sort?: string; tags?: string }) =>
    honoRequest<{ bounties: any[]; total: number; page: number; pageSize: number }>(
      `/api/bounties?${new URLSearchParams(Object.entries(params || {}).filter(([,v]) => v != null).map(([k,v]) => [k, String(v)])).toString()}`
    ),
  getBounty: (id: string) =>
    honoRequest<{ bounty: any; rewards: any[]; attemptCount: number }>(`/api/bounties/${id}`),
  getFeaturedBounties: () =>
    honoRequest<{ bounties: any[] }>('/api/bounties/featured'),
  createBounty: (data: any) =>
    honoRequest<{ bounty: any }>('/api/bounties/create', { method: 'POST', body: JSON.stringify(data) }),
  updateBounty: (id: string, data: any) =>
    honoRequest<{ bounty: any }>(`/api/bounties/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  cancelBounty: (id: string) =>
    honoRequest<{ success: boolean }>(`/api/bounties/${id}`, { method: 'DELETE' }),
  getMyBounties: () =>
    honoRequest<{ bounties: any[] }>('/api/bounties/my-bounties'),
  claimBounty: (id: string) =>
    honoRequest<{ attempt: any }>(`/api/bounties/${id}/claim`, { method: 'POST' }),
  submitBountyAttempt: (id: string, data: { prLink?: string; submissionNote: string }) =>
    honoRequest<{ attempt: any }>(`/api/bounties/${id}/submit`, { method: 'POST', body: JSON.stringify(data) }),
  abandonBounty: (id: string) =>
    honoRequest<{ success: boolean }>(`/api/bounties/${id}/abandon`, { method: 'POST' }),
  getMyBountyAttempts: () =>
    honoRequest<{ attempts: any[] }>('/api/bounties/my-attempts'),
  reviewBountyAttempt: (attemptId: string, data: { decision: string; reviewNote?: string }) =>
    honoRequest<{ success: boolean }>(`/api/bounties/attempts/${attemptId}/review`, { method: 'POST', body: JSON.stringify(data) }),
  getBountyReputation: (petId: string) =>
    honoRequest<{ reputation: any }>(`/api/bounties/reputation/${petId}`),

  // Leaderboard (P4 — single ClawVille-owned ranking board)
  getLeaderboard: (params?: {
    sort?:
      | 'composite'
      | 'gold'
      | 'earned'
      | 'skills-sold'
      | 'skills-authored'
      | 'quests'
      | 'bounties';
    limit?: number;
    offset?: number;
    me?: boolean;
  }) => {
    const search = new URLSearchParams();
    if (params?.sort) search.set('sort', params.sort);
    if (params?.limit != null) search.set('limit', String(params.limit));
    if (params?.offset != null) search.set('offset', String(params.offset));
    if (params?.me) search.set('me', '1');
    const qs = search.toString();
    return honoRequest<{
      entries: Array<{
        rank: number;
        petId: string;
        petName: string;
        species: string;
        color: string | number | null;
        archetype: string | null;
        gold: number;
        earned: number;
        skillsSold: number;
        skillsAuthored: number;
        questsCompleted: number;
        bountiesCompleted: number;
        compositeScore: number;
      }>;
      sort: string;
      limit: number;
      offset: number;
      totalPets: number;
      rankedCount: number;
      generatedAt: string;
      me: {
        rank: number;
        petId: string;
        petName: string;
        species: string;
        gold: number;
        earned: number;
        skillsSold: number;
        skillsAuthored: number;
        questsCompleted: number;
        bountiesCompleted: number;
        compositeScore: number;
      } | null;
    }>(`/api/leaderboard${qs ? '?' + qs : ''}`);
  },

  getLeaderboardStats: () =>
    honoRequest<{
      totalPets: number;
      rankedPets: number;
      totalGold: number;
      totalEarned: number;
      totalSkillsSold: number;
      totalSkillsAuthored: number;
      totalQuestsCompleted: number;
      totalBountiesCompleted: number;
      generatedAt: string;
    }>('/api/leaderboard/stats'),

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

  // Agent Setup
  getAgentRoster: () =>
    honoRequest<{ agents: any[] }>('/api/agent-setup/roster'),

  createAgent: (data: {
    name: string;
    species: string;
    color: string;
    gender: string;
    archetypeId: string;
    personality: { habitat: string; hobby: string; greeting: string };
  }) =>
    honoRequest<{ agent: any }>('/api/agent-setup/create', { method: 'POST', body: JSON.stringify(data) }),

  activateAgent: (id: string) =>
    honoRequest<{ success: boolean }>(`/api/agent-setup/${id}/activate`, { method: 'PATCH' }),

  deleteAgent: (id: string) =>
    honoRequest<{ success: boolean }>(`/api/agent-setup/${id}`, { method: 'DELETE' }),

  updateLoadout: (id: string, equippedSkills: string[]) =>
    honoRequest<{ success: boolean }>(`/api/agent-setup/${id}/loadout`, { method: 'PATCH', body: JSON.stringify({ equippedSkills }) }),

  getAgentTalentTree: (id: string) =>
    honoRequest<{ buildings: any[] }>(`/api/agent-setup/${id}/talent-tree`),

  exportAgent: (id: string) =>
    honoRequest<{ config: any }>(`/api/agent-setup/${id}/export`, { method: 'POST' }),

  importAgent: (configData: any, slotIndex?: number) =>
    honoRequest<{ agent: any }>('/api/agent-setup/import', { method: 'POST', body: JSON.stringify({ configData, slotIndex }) }),

  getAgentConfigs: () =>
    honoRequest<{ configs: any[] }>('/api/agent-setup/configs'),

  getPublicConfigs: () =>
    honoRequest<{ configs: any[] }>('/api/agent-setup/configs/public'),
};
