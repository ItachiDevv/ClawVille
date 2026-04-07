import { BUILDING_OPENCLAW_THEMES } from '@legacyapp/shared';
import type { ResearchThoughtEvent, ResearchPhase } from '@legacyapp/shared';
import { articleScraper } from './article-scraper';
import { generateSkillMd } from './skill-generator';

type ThoughtEmitter = (event: ResearchThoughtEvent) => void;

function makeEvent(
  base: { sessionId: string; avatarId: string; locationId: string },
  phase: ResearchPhase,
  message: string,
  extra?: Partial<ResearchThoughtEvent>,
): ResearchThoughtEvent {
  return {
    type: 'research_thought',
    ...base,
    phase,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Local knowledge extraction — no external LLM calls needed.
// Parses scraped article text into structured knowledge entries.
// ---------------------------------------------------------------------------

/**
 * Extract knowledge entries from a single article's scraped text.
 * Pulls sentences that contain actionable info (tools, APIs, patterns, commands).
 */
function extractKnowledgeFromArticle(title: string, content: string, source: string): string[] {
  const entries: string[] = [];

  // Split into sentences
  const sentences = content
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 300);

  // Score sentences by how actionable/informative they are
  const actionWords = /\b(use|create|configure|deploy|install|run|set up|define|implement|enable|specify|requires?|supports?|provides?|allows?|integrates?|connects?|sends?|receives?|handles?|processes?|stores?|retrieves?|generates?|builds?|returns?)\b/i;
  const techWords = /\b(API|SDK|CLI|JSON|HTTP|REST|webhook|endpoint|token|auth|config|schema|query|database|model|agent|plugin|tool|function|parameter|request|response|stream|event|callback|cron|schedule|vector|embed|memory|prompt|context)\b/i;
  const noisePatterns = /\b(click here|sign up|subscribe|cookie|privacy policy|terms of service|navigation|menu|footer|sidebar)\b/i;

  for (const sentence of sentences) {
    if (noisePatterns.test(sentence)) continue;

    const hasAction = actionWords.test(sentence);
    const hasTech = techWords.test(sentence);

    if (hasAction && hasTech) {
      entries.push(sentence);
    }
  }

  // Cap at 8 entries per article, deduplicate similar ones
  const unique = deduplicateEntries(entries);
  const capped = unique.slice(0, 8);

  // Tag with source
  return capped.map((e) => `${e} (from ${source}: ${title})`);
}

/**
 * Remove near-duplicate entries (entries sharing >60% of words).
 */
function deduplicateEntries(entries: string[]): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    const words = new Set(entry.toLowerCase().split(/\s+/));
    const isDupe = result.some((existing) => {
      const existingWords = new Set(existing.toLowerCase().split(/\s+/));
      const overlap = [...words].filter((w) => existingWords.has(w)).length;
      return overlap / Math.min(words.size, existingWords.size) > 0.6;
    });
    if (!isDupe) result.push(entry);
  }
  return result;
}

export class ResearchService {
  /**
   * Run the research pipeline for a location.
   * Scrapes cached articles → extracts knowledge locally → generates SKILL.md.
   * No external LLM API calls required.
   */
  async research(opts: {
    sessionId: string;
    avatarId: string;
    locationId: string;
    avatarName: string;
    existingKnowledge: string[];
    emit: ThoughtEmitter;
    themeOverride?: { label: string; focus: string };
  }): Promise<{
    synthesizedKnowledge: string[];
    skillMd: string;
  }> {
    const { sessionId, avatarId, locationId, avatarName, existingKnowledge, emit, themeOverride } = opts;
    const base = { sessionId, avatarId, locationId };
    const theme = themeOverride ?? BUILDING_OPENCLAW_THEMES[locationId];
    const themeName = theme?.label ?? locationId;
    const themeFocus = theme?.focus ?? 'AI agent development topics';

    try {
      // Phase 1: Fetch cached articles
      emit(makeEvent(base, 'fetching_articles', `Loading research materials for ${themeName}...`, { progress: 5 }));

      const articles = await articleScraper.getArticlesForLocation(locationId);

      if (articles.length === 0) {
        emit(makeEvent(base, 'error', `No articles cached for ${themeName}. Run /api/research/seed first.`));
        return { synthesizedKnowledge: [], skillMd: '' };
      }

      emit(makeEvent(base, 'fetching_articles', `Found ${articles.length} articles for ${themeName}`, {
        progress: 10,
        articleCount: articles.length,
      }));

      // Phase 2: Extract knowledge from each article locally
      const allEntries: string[] = [];

      for (let i = 0; i < articles.length; i++) {
        const article = articles[i] as any;
        emit(makeEvent(base, 'reading', `Reading: ${article.title}...`, {
          articleIndex: i,
          articleCount: articles.length,
          progress: 10 + Math.round(((i + 1) / articles.length) * 50),
        }));

        const entries = extractKnowledgeFromArticle(
          article.title,
          article.content,
          article.source,
        );

        for (const entry of entries) {
          emit(makeEvent(base, 'reading', `Learned: ${entry.slice(0, 100)}${entry.length > 100 ? '...' : ''}`, {
            progress: 10 + Math.round(((i + 1) / articles.length) * 50),
          }));
        }

        allEntries.push(...entries);
      }

      if (allEntries.length === 0) {
        emit(makeEvent(base, 'error', 'No knowledge entries extracted from articles.'));
        return { synthesizedKnowledge: [], skillMd: '' };
      }

      // Phase 3: Deduplicate and filter out existing knowledge
      emit(makeEvent(base, 'synthesizing', `Deduplicating ${allEntries.length} entries...`, { progress: 70 }));

      const existingSet = new Set(existingKnowledge.map((k) => k.toLowerCase()));
      const newEntries = deduplicateEntries(allEntries).filter(
        (e) => !existingSet.has(e.toLowerCase()),
      );

      emit(makeEvent(base, 'synthesizing', `${newEntries.length} new knowledge entries (${allEntries.length - newEntries.length} duplicates removed)`, { progress: 85 }));

      // Phase 4: Create skill
      emit(makeEvent(base, 'creating_skill', 'Compiling SKILL.md...', { progress: 90 }));

      const skillResult = generateSkillMd({
        avatarName,
        species: 'unknown',
        archetype: 'researcher',
        avatarId,
        clawTokens: 0,
        bio: [`${avatarName} is an AI agent trained at the ${themeName} in ClawVille World.`],
        knowledge: [...existingKnowledge, ...newEntries],
        topics: [themeFocus],
        lore: [`Studied ${articles.length} articles about ${themeName}`],
        style: { all: ['concise', 'educational', 'practical'] },
        customName: `${avatarName}-${themeName.toLowerCase().replace(/\s+/g, '-')}`,
        customDescription: `${themeName} knowledge researched by ${avatarName}`,
        selectedKnowledge: newEntries,
      });

      // Phase 5: Complete
      emit(makeEvent(base, 'complete', `Research complete! ${newEntries.length} new knowledge entries from ${articles.length} articles`, {
        progress: 100,
        synthesizedKnowledge: newEntries,
        skillMd: skillResult.markdown,
      }));

      return {
        synthesizedKnowledge: newEntries,
        skillMd: skillResult.markdown,
      };
    } catch (err: any) {
      emit(makeEvent(base, 'error', `Research failed: ${err.message}`));
      return { synthesizedKnowledge: [], skillMd: '' };
    }
  }
}

export const researchService = new ResearchService();
