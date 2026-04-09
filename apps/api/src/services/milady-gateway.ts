import {
  BUILDING_MILADY_SKILLS,
  type MiladyGatewayConfig,
  type MiladySkillDefinition,
} from '@legacyapp/shared';

class MiladyGatewayClient {
  private config: MiladyGatewayConfig | null;
  private availableCache: { value: boolean; expiresAt: number } | null = null;

  constructor() {
    const enabled = process.env.MILADY_GATEWAY_ENABLED === 'true';
    const baseUrl = process.env.MILADY_GATEWAY_URL;
    const authToken = process.env.MILADY_AUTH_TOKEN;

    if (enabled && baseUrl && authToken) {
      this.config = {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        authToken,
        timeoutMs: 5000,
      };
      console.log(`[Milady] Gateway configured: ${this.config.baseUrl}`);
    } else {
      this.config = null;
      console.log('[Milady] Gateway not configured (disabled or missing env vars)');
    }
  }

  /** Check if Milady gateway is configured and responding (cached for 30s) */
  isAvailable(): boolean {
    if (!this.config) return false;
    if (this.availableCache && Date.now() < this.availableCache.expiresAt) {
      return this.availableCache.value;
    }
    // Optimistic: return true if configured, async health check updates cache
    this.checkHealth().catch(() => {});
    return this.availableCache?.value ?? true;
  }

  private async checkHealth(): Promise<void> {
    if (!this.config) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`${this.config.baseUrl}/api/agent/status`, {
          headers: { Authorization: `Bearer ${this.config.authToken}` },
          signal: controller.signal,
        });
        this.availableCache = { value: res.ok, expiresAt: Date.now() + 30_000 };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      this.availableCache = { value: false, expiresAt: Date.now() + 30_000 };
    }
  }

  /** Search Milady's knowledge base for relevant fragments */
  async fetchMiladyInsights(query: string, buildingId?: string): Promise<string[]> {
    if (!this.config) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000);
    try {
      const url = new URL(`${this.config.baseUrl}/api/knowledge/search`);
      url.searchParams.set('query', query);
      if (buildingId) url.searchParams.set('tag', buildingId);
      url.searchParams.set('limit', '3');

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.config.authToken}` },
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { fragments?: Array<{ content: string }> };
      return (data.fragments ?? []).map((f) => f.content).filter(Boolean).slice(0, 3);
    } catch (err) {
      console.warn('[Milady] Knowledge search failed:', err);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Ingest a knowledge document into Milady */
  async syncKnowledge(
    content: string,
    metadata: { source: string; buildingId?: string },
  ): Promise<boolean> {
    if (!this.config) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000);
    try {
      const res = await fetch(`${this.config.baseUrl}/api/knowledge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({ content, metadata }),
        signal: controller.signal,
      });
      return res.ok;
    } catch (err) {
      console.warn('[Milady] Knowledge sync failed:', err);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Export a building's knowledge as a Milady skill package */
  async exportSkill(
    buildingId: string,
    knowledgeEntries: string[],
  ): Promise<{ success: boolean; skillId?: string }> {
    const skillDef = BUILDING_MILADY_SKILLS[buildingId];
    if (!skillDef) return { success: false };
    if (!this.config) {
      // Return skill definition without installing (offline export)
      return { success: true, skillId: skillDef.skillId };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000);
    try {
      const res = await fetch(`${this.config.baseUrl}/api/skills/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({
          id: skillDef.skillId,
          name: skillDef.name,
          description: skillDef.description,
          category: skillDef.category,
          knowledge: knowledgeEntries,
          source: 'clawville',
        }),
        signal: controller.signal,
      });
      if (!res.ok) return { success: false };
      return { success: true, skillId: skillDef.skillId };
    } catch (err) {
      console.warn('[Milady] Skill export failed:', err);
      return { success: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Get skill progress for a building */
  getSkillDefinition(buildingId: string): MiladySkillDefinition | undefined {
    return BUILDING_MILADY_SKILLS[buildingId];
  }
}

export const miladyGateway = new MiladyGatewayClient();
