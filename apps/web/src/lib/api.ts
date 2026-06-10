import type { AgentCategory, AgentHarness } from '@clawville/shared';
import { getFingerprint } from './fingerprint';

// request() targets the Hono API exactly like honoRequest() — its paths
// (/api/auth/guest, forgot/reset-password, send-verification, /api/chat/transient,
// /api/items/*, /api/avatars/me, location chat, username flows) have NO
// Next.js app-route implementation (apps/web/src/app/api/** is empty), so
// same-origin fetches 404 on prod AND localhost. Master (3cf8a860) semantics
// restored 2026-06-10. Local-dev cookie isolation is an EXPLICIT opt-in:
// set NEXT_PUBLIC_API_SAME_ORIGIN=1 in .env.local (build-time env, local
// builds ONLY — never prod/staging) to force same-origin fetches so a local
// build pointed at staging does not inherit staging cookies/auth state.
const API_URL =
  process.env.NEXT_PUBLIC_API_SAME_ORIGIN === '1'
    ? ''
    : process.env.NEXT_PUBLIC_API_URL || '';
const HONO_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Phase 1 anti-farm — inject the browser fingerprint header on every API
 * call. Server middleware (apps/api/src/middleware/fingerprint.ts) hashes
 * it with FINGERPRINT_SECRET before persisting. Empty fingerprint (SSR or
 * load error) is omitted so the server's UA+IP fallback fires.
 */
async function withFingerprint(
  base: HeadersInit | undefined,
): Promise<HeadersInit> {
  const fp = await getFingerprint();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(base as Record<string, string> | undefined),
  };
  if (fp) headers['X-CV-Fingerprint'] = fp;
  return headers;
}

async function honoRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = await withFingerprint(options?.headers);
  const res = await fetch(`${HONO_API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = await withFingerprint(options?.headers);
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// Shape returned by POST /api/auth/guest — see auth.ts handler.
export interface GuestSignupResponse {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    isGuest?: boolean;
    guestExpiresAt?: string;
  };
  avatar: {
    id: string;
    name: string;
  } | null;
  reused: boolean;
}

export const api = {
  // Auth
  signup: (data: { email: string; password: string; name?: string }) =>
    request<{ success: boolean }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /**
   * Guest avatar auto-create — un-authenticated visitors get a throwaway
   * user + avatar so they can play activities + chat with NPCs. Idempotent
   * for callers who already have a Lucia session.
   *
   * Brand carve-out: guests don't appear on leaderboards, but still
   * earn ClawTokens in matches.
   */
  guestSignup: (data?: { requestedName?: string }) =>
    request<GuestSignupResponse>('/api/auth/guest', {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }),

  login: (data: { email: string; password: string }) =>
    request<{ success: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    request<{ success: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () =>
    request<{
      user: {
        id: string;
        email: string;
        name: string;
        /** Public handle — added 2026-05-19, null for legacy un-backfilled rows */
        username: string | null;
        /**
         * Email-verification state — added 2026-05-21. Drives the soft
         * "Confirm your email" banner on /game. `false` for legacy users
         * pre-verification rollout (they get the banner one time, dismiss
         * to silence). `true` once the user clicks the verify link.
         */
        emailVerified: boolean;
        /**
         * Guest accounts (Milady-bootstrapped or unauth visitor guest
         * avatar) have placeholder emails and skip the verify banner.
         * Surfaced here so the UI doesn't need a second round trip.
         */
        isGuest: boolean;
      };
    }>('/api/auth/me'),

  // -------------------------------------------------------------------------
  // Email-driven auth flows (added 2026-05-21).
  // forgotPassword + resetPassword + sendVerification follow the same
  // "never leak whether the email exists" discipline as the server
  // routes — they always resolve, even when the server returns 4xx for
  // a bad token, so the UI can render the generic success/failure copy
  // without branching on enumeration signals.
  // -------------------------------------------------------------------------
  forgotPassword: (email: string) =>
    request<{ ok: boolean; message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    }),

  // Authenticated — re-sends the verification email to the current
  // user's address. No-op for guests (returns 200 with sent=false).
  sendVerification: () =>
    request<{ ok: boolean; sent: boolean; reason?: string }>('/api/auth/send-verification', {
      method: 'POST',
    }),

  // Username availability probe — public, case-insensitive. Used by the
  // settings modal as the user types a new handle.
  checkUsername: (name: string) =>
    request<{ available: boolean; reason?: string }>(
      `/api/users/check-username/${encodeURIComponent(name)}`,
    ),

  // Update the caller's username. 429 on rate limit (5/min/IP); 409 if
  // taken by another user; 400 on format violation.
  updateUsername: (username: string) =>
    request<{ user: { id: string; username: string }; changed: boolean }>(
      '/api/users/me/username',
      { method: 'PATCH', body: JSON.stringify({ username }) },
    ),

  // Phase 6 — authoritative agent-session liveness probe. UI calls on
  // game-page mount to hydrate `agentConnected` from the server instead
  // of trusting the client-only zustand flag.
  getAgentSession: () =>
    request<{
      connected: boolean;
      agentId?: string;
      harness?: string | null;
      expiresAt?: string | null;
      lastSeenAt?: string | null;
      reason?: 'no_bot' | 'expired';
    }>('/api/auth/me/agent-session'),

  // Phase 6.7.5 — claim guest cove history rows for the current Lucia
  // session. Called from the signup success path. Idempotent — repeat
  // calls for the same fp_hash return claimed=0.
  claimCoveHistory: () =>
    honoRequest<{ claimed: number; eventIds: string[]; sessionsClaimed: number }>(
      '/api/cove/history/claim',
      { method: 'POST' },
    ),

  // Avatars
  createAvatar: (data: {
    name: string;
    species: string;
    color: string;
    gender: string;
    archetypeId: string;
    personality: { habitat: string; hobby: string; greeting: string };
    /** Phase 2 — 3D model key from AGENT_MODELS registry */
    modelKey?: string;
    /**
     * Phase 2 — agent framework category. Imported from @clawville/shared
     * so the union widens automatically when the registry adds a category.
     */
    agentCategory?: AgentCategory;
    /** Phase 2 — preferred runtime harness. Imported from @clawville/shared. */
    harness?: AgentHarness;
  }) =>
    request<{
      avatar: any;
      agentId: string;
      /**
       * Phase 4d — first-time identity keypair disclosure. Present only
       * when the avatar was created by an auto-provisioned (unauth) call.
       * `secretKey` is base58 ed25519, shown exactly ONCE per Phase 5.1
       * doctrine. The client MUST capture and surface it for backup.
       */
      identity?: {
        userId: string;
        publicKey: string;
        secretKey: string;
      };
      /**
       * Phase 4d — first-time custodial Solana wallet disclosure.
       * Present only on auto-provision. `secretKey` is base58 Solana
       * keypair, shown once — server never re-discloses.
       */
      wallet?: {
        address: string;
        secretKey: string;
        chain: 'solana';
      };
    }>('/api/avatars', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getMyAvatar: () => request<{ avatar: any }>('/api/avatars/me'),

  // Avatar chat (chat with your own avatar)
  sendAvatarChat: (content: string) =>
    request<{ message: { role: string; content: string; timestamp: string } }>(
      '/api/avatars/me/chat',
      {
        method: 'POST',
        body: JSON.stringify({ content }),
      }
    ),

  // Transient world-NPC chat — used by TalkToCharacterBar in NPC mode.
  // Stateless one-shot Gemini; no Eliza, no DB writes. Client owns history.
  sendTransientChat: (
    characterName: string,
    message: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ) =>
    request<{ message: { role: string; content: string; timestamp: string } }>(
      '/api/chat/transient',
      {
        method: 'POST',
        body: JSON.stringify({ characterName, message, history }),
      }
    ),

  updateAvatarPosition: (positionX: number, positionY: number) =>
    request<{ avatar: any }>('/api/avatars/me', {
      method: 'PATCH',
      body: JSON.stringify({ positionX, positionY }),
    }),

  // Phase 4c Layer 1 — in-game appearance edit. Backend validates modelKey
  // stays within the current harness pool (Milady ↔ Milady, non-Milady ↔
  // non-Milady) so appearance swaps can't bypass the hosting contract.
  editAvatarAppearance: (data: {
    modelKey?: string;
    color?: 'green' | 'red' | 'blue' | 'yellow';
    gender?: 'male' | 'female';
  }) =>
    request<{ avatar: any }>('/api/avatars/me/appearance', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  checkAvatarName: (name: string) =>
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

  // System-agent chat (Town Guide, future arena host, quest giver, etc.).
  // Target: Hono API at POST /api/chat/system/:slug. NOTE: backend schema
  // requires { content: string }, NOT { message: string } — different from
  // some sibling chat routes.
  sendSystemChat: (slug: string, content: string) =>
    honoRequest<{ message: { role: string; content: string; timestamp: string } }>(
      `/api/chat/system/${slug}`,
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
    request<{ success: boolean; clawTokens: number; item: { id: string; name: string; isBook?: boolean } }>(
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

  // Persists `avatars.flags.agentBannerDismissed = true` server-side so the
  // green "Bot Training Active" pill stops re-asserting on every page reload
  // for Milady-only accounts (no external bot to expire). Cleared again
  // automatically the next time the user mints a Connect URL.
  dismissAgentBanner: () =>
    honoRequest<{ ok: true; dismissed: true }>('/api/avatars/me/dismiss-agent-banner', {
      method: 'POST',
    }),

  // Agent-initiated connection (Moltbook pattern)
  generateConnectToken: (data: {
    avatarId: string;
    avatarName: string;
    userId: string;
    /** Phase 6.1 — optional free-text focus ("cron jobs", "solana signing"). Server clamps to 120 chars. */
    learningFocus?: string;
  }) =>
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

  // Public world-view roster. Carries NO session id (auth-lens fix #1,
  // 2026-06-03 — the session id is a real-CT bearer credential and this is a
  // public endpoint); bodies are addressed by their stable public `agentId`.
  getActiveOpenClawBots: () =>
    honoRequest<{
      bots: Array<{ agentId: string; mode: string; npcId?: string; name?: string }>;
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
    avatarContext?: {
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
    avatarContext?: {
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
  sendAvatarHeartbeat: (positionX: number, positionY: number) =>
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
    const headers = await withFingerprint(undefined);
    const res = await fetch(`${HONO_API_URL}/api/openclaw/knowledge-export/${avatarId}?format=markdown`, {
      credentials: 'include',
      headers,
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

  // Q3 plan §2.6 — Server-credited tutorial quest reward. Called from the
  // zustand quest store on each newly-completed tutorial quest. Idempotent
  // server-side — repeat calls return 409 with the existing balance.
  claimTutorialQuest: (questId: string) =>
    honoRequest<{
      ok: boolean;
      questId?: string;
      credited: number;
      balance: number;
      error?: string;
      reason?: string;
      message?: string;
    }>(`/api/quests/tutorial/${questId}/claim`, { method: 'POST' }),
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
  getBountyReputation: (avatarId: string) =>
    honoRequest<{ reputation: any }>(`/api/bounties/reputation/${avatarId}`),

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
        avatarId: string;
        avatarName: string;
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
      totalAvatars: number;
      rankedCount: number;
      generatedAt: string;
      me: {
        rank: number;
        avatarId: string;
        avatarName: string;
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
      totalAvatars: number;
      rankedAvatars: number;
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

  // Phase 5.1 — Portal (Cross to 'scape). See plan §9.6 + §15.
  // Both endpoints are Lucia-authed; uses honoRequest because the Hono
  // API owns `/api/portal/*`.
  crossToScape: () =>
    honoRequest<{ redirectUrl: string }>('/api/portal/scape', {
      method: 'POST',
    }),

  generateScapeLinkCode: () =>
    honoRequest<{ code: string; expiresAt: string }>('/api/portal/scape-link-code', {
      method: 'POST',
    }),

  // Phase 4a — "Take my agent home to Milady". Emits a Milady-install
  // payload + a copy-pasteable curl one-liner the user runs locally.
  // The port is NOT assumed — users who run Milady on a non-default port
  // pass `miladyBaseUrl` and the server rebuilds the curl accordingly.
  exportCharacter: (data: { avatarId: string; miladyBaseUrl?: string }) =>
    honoRequest<{
      character: unknown;
      skillPack: unknown[];
      miladyInstallPayload: unknown;
      installCommand: string;
      exportedAt: string;
      summary: {
        modelKey: string;
        agentCategory: AgentCategory;
        harness: AgentHarness;
        skillsCount: number;
        knowledgeCount: number;
      };
    }>('/api/agent/export-character', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

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
