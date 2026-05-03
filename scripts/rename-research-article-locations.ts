import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, researchArticles } from '@clawville/database';
import { eq } from 'drizzle-orm';

const RENAME_MAP: Record<string, string> = {
  'cron-hub': 'cron-automation',
  'webhook-gateway': 'api-integrations',
  'memory-vault': 'memory-rag',
  'skill-forge': 'code-development',
  'channel-bridge': 'messaging-channels',
  'tool-workshop': 'mcp-tool-use',
  'canvas-studio': 'visual-creation',
  'voice-tower': 'app-publishing',
  'security-fortress': 'agent-security',
  'config-citadel': 'deployment-ops',
};

async function rename() {
  let total = 0;
  for (const [oldId, newId] of Object.entries(RENAME_MAP)) {
    const updated = await db
      .update(researchArticles)
      .set({ locationId: newId })
      .where(eq(researchArticles.locationId, oldId))
      .returning({ id: researchArticles.id });
    if (updated.length > 0) {
      console.log(`  ${oldId} → ${newId}: ${updated.length} rows`);
      total += updated.length;
    }
  }
  console.log(`Total: ${total} research_articles rows renamed.`);
  process.exit(0);
}

rename().catch((err) => {
  console.error(err);
  process.exit(1);
});
