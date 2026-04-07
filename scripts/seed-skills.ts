/**
 * Seed precompiled SKILL.md files into the marketplace.
 *
 * Pipeline: scraped articles → local knowledge extraction → SKILL.md → published to marketplace
 *
 * Run: bun run scripts/seed-skills.ts
 */
import { db, publishedSkills, eq, and } from '../packages/database/src/index';
import { BUILDING_OPENCLAW_THEMES, LOCATION_ARTICLE_SEEDS } from '../packages/shared/src/index';
import { articleScraper } from '../apps/api/src/services/article-scraper';
import { researchService } from '../apps/api/src/services/research-service';

async function seedSkills() {
  console.log('=== ClawVille Skill Seeder ===\n');

  // Step 1: Ensure articles are scraped
  console.log('[1/3] Checking scraped articles...');
  const existing = await db.select().from((await import('../packages/database/src/schema/research')).researchArticles);
  const successCount = existing.filter((a) => a.scrapeStatus === 'success').length;

  if (successCount < 10) {
    console.log(`  Only ${successCount} articles cached. Running full scrape...`);
    const result = await articleScraper.seedAll((loc, i, t) => {
      process.stdout.write(`\r  Scraping ${loc}: ${i}/${t}  `);
    });
    console.log(`\n  Scrape complete: ${result.success} success, ${result.failed} failed`);
  } else {
    console.log(`  ${successCount} articles already cached. Skipping scrape.`);
  }

  // Step 2: Generate SKILL.md per building and publish
  console.log('\n[2/3] Generating and publishing skills per building...\n');

  const locationIds = Object.keys(BUILDING_OPENCLAW_THEMES);
  let published = 0;
  let skipped = 0;

  for (const locationId of locationIds) {
    const theme = BUILDING_OPENCLAW_THEMES[locationId];
    const skillName = `${theme.label} — Agent Skills`;

    // Check if already published for this location
    const existingSkill = await db.query.publishedSkills.findFirst({
      where: and(
        eq(publishedSkills.locationId, locationId),
        eq(publishedSkills.authorClawName, 'ClawVille'),
      ),
    });

    if (existingSkill) {
      console.log(`  ✓ ${theme.label} — already published, skipping`);
      skipped++;
      continue;
    }

    // Run the research pipeline (local extraction, no LLM calls)
    const result = await researchService.research({
      sessionId: `seed-${locationId}`,
      avatarId: 'system',
      locationId,
      avatarName: 'ClawVille',
      existingKnowledge: [],
      emit: () => {}, // silent
    });

    if (result.synthesizedKnowledge.length === 0) {
      console.log(`  ✗ ${theme.label} — no knowledge extracted, skipping`);
      continue;
    }

    // Publish to marketplace
    await db.insert(publishedSkills).values({
      authorClawName: 'ClawVille',
      authorClawSpecies: 'system',
      locationId,
      name: skillName,
      description: `${theme.focus} — precompiled from ${result.synthesizedKnowledge.length} knowledge entries`,
      skillMd: result.skillMd,
      price: 0,
    });

    console.log(`  ✓ ${theme.label} — published ${result.synthesizedKnowledge.length} entries`);
    published++;
  }

  // Step 3: Summary
  console.log(`\n[3/3] Done! Published: ${published}, Skipped: ${skipped}\n`);

  // List all marketplace skills
  const allSkills = await db.select({
    name: publishedSkills.name,
    locationId: publishedSkills.locationId,
    downloadCount: publishedSkills.downloadCount,
  }).from(publishedSkills);

  console.log('Marketplace skills:');
  for (const s of allSkills) {
    console.log(`  - ${s.name} (${s.locationId}) — ${s.downloadCount} downloads`);
  }

  process.exit(0);
}

seedSkills().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
