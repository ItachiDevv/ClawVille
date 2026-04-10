import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import { db, researchArticles, eq, and } from '@clawville/database';
import { LOCATION_ARTICLE_SEEDS } from '@clawville/shared';
import type { ResearchArticleSeed } from '@clawville/shared';

export class ArticleScraper {
  /**
   * Scrape a single URL and return clean markdown content.
   */
  async scrapeUrl(url: string): Promise<{ title: string; content: string; wordCount: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ClawVille-Research/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const html = await res.text();
      const $ = cheerio.load(html);

      // Remove noise elements
      $('nav, footer, header, script, style, aside, iframe, noscript').remove();
      $('.ads, .sidebar, .cookie-banner, .newsletter, .popup, .social-share, [role="navigation"]').remove();

      // Extract article content with fallback chain
      let bodyText = '';
      const selectors = ['article', '[role="main"]', 'main', '.post-content', '.article-body', '.entry-content', '.content'];
      for (const sel of selectors) {
        const el = $(sel);
        if (el.length && el.text().trim().length > 200) {
          bodyText = el.text();
          break;
        }
      }
      if (!bodyText) {
        bodyText = $('body').text();
      }

      // Clean up whitespace
      const content = bodyText
        .replace(/\s+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 8000); // Cap at ~8k chars

      const title = $('h1').first().text().trim() || $('title').text().trim() || '';
      const wordCount = content.split(/\s+/).length;

      return { title, content, wordCount };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Seed all articles from LOCATION_ARTICLE_SEEDS into the database.
   */
  async seedAll(onProgress?: (location: string, index: number, total: number) => void): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const [locationId, seeds] of Object.entries(LOCATION_ARTICLE_SEEDS) as [string, ResearchArticleSeed[]][]) {
      for (let i = 0; i < seeds.length; i++) {
        const seed = seeds[i];
        onProgress?.(locationId, i + 1, seeds.length);

        try {
          // Check if already exists
          const existing = await db.query.researchArticles.findFirst({
            where: and(
              eq(researchArticles.locationId, locationId),
              eq(researchArticles.url, seed.url),
            ),
          });

          if (existing && existing.scrapeStatus === 'success') {
            success++;
            continue;
          }

          const scraped = await this.scrapeUrl(seed.url);
          const contentHash = createHash('sha256').update(scraped.content).digest('hex');

          if (existing) {
            await db.update(researchArticles).set({
              title: scraped.title || seed.title,
              content: scraped.content,
              contentHash,
              scrapeStatus: 'success',
              scrapedAt: new Date(),
              updatedAt: new Date(),
              metadata: { wordCount: scraped.wordCount },
            }).where(eq(researchArticles.id, existing.id));
          } else {
            await db.insert(researchArticles).values({
              locationId,
              url: seed.url,
              title: scraped.title || seed.title,
              source: seed.source,
              content: scraped.content,
              contentHash,
              scrapeStatus: 'success',
              scrapedAt: new Date(),
              metadata: { wordCount: scraped.wordCount },
            });
          }
          success++;
        } catch (err: any) {
          console.error(`[Scraper] Failed to scrape ${seed.url}:`, err.message);
          // Insert as failed so we can retry later
          try {
            const existing = await db.query.researchArticles.findFirst({
              where: and(
                eq(researchArticles.locationId, locationId),
                eq(researchArticles.url, seed.url),
              ),
            });
            if (!existing) {
              await db.insert(researchArticles).values({
                locationId,
                url: seed.url,
                title: seed.title,
                source: seed.source,
                content: '',
                scrapeStatus: 'failed',
                scrapedAt: new Date(),
                metadata: { errorMessage: err.message },
              });
            }
          } catch { /* ignore db error on failure insert */ }
          failed++;
        }

        // Rate limit: 500ms between scrapes
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    console.log(`[Scraper] Seed complete: ${success} success, ${failed} failed`);
    return { success, failed };
  }

  /**
   * Re-scrape all articles for a single location.
   */
  async refreshLocation(locationId: string): Promise<{ success: number; failed: number }> {
    const seeds = LOCATION_ARTICLE_SEEDS[locationId];
    if (!seeds) {
      throw new Error(`No article seeds for location: ${locationId}`);
    }

    let success = 0;
    let failed = 0;

    for (const seed of seeds) {
      try {
        const scraped = await this.scrapeUrl(seed.url);
        const contentHash = createHash('sha256').update(scraped.content).digest('hex');

        const existing = await db.query.researchArticles.findFirst({
          where: and(
            eq(researchArticles.locationId, locationId),
            eq(researchArticles.url, seed.url),
          ),
        });

        if (existing) {
          await db.update(researchArticles).set({
            title: scraped.title || seed.title,
            content: scraped.content,
            contentHash,
            scrapeStatus: 'success',
            scrapedAt: new Date(),
            updatedAt: new Date(),
            metadata: { wordCount: scraped.wordCount },
          }).where(eq(researchArticles.id, existing.id));
        } else {
          await db.insert(researchArticles).values({
            locationId,
            url: seed.url,
            title: scraped.title || seed.title,
            source: seed.source,
            content: scraped.content,
            contentHash,
            scrapeStatus: 'success',
            scrapedAt: new Date(),
            metadata: { wordCount: scraped.wordCount },
          });
        }
        success++;
      } catch (err: any) {
        console.error(`[Scraper] Failed to refresh ${seed.url}:`, err.message);
        failed++;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    return { success, failed };
  }

  /**
   * Get all successfully scraped articles for a location.
   */
  async getArticlesForLocation(locationId: string) {
    const articles = await db.query.researchArticles.findMany({
      where: and(
        eq(researchArticles.locationId, locationId),
        eq(researchArticles.scrapeStatus, 'success'),
      ),
    });
    return articles;
  }
}

export const articleScraper = new ArticleScraper();
