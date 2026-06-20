import { Hono } from 'hono';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { AppContext } from '../types';

export const i18nRoutes = new Hono<AppContext>();

const OPENAI_MODEL = process.env.OPENAI_SMALL_MODEL ?? 'gpt-4o-mini';
const MAX_ENTRIES_PER_REQUEST = 80;
const MAX_TEXT_CHARS = 600;
const MAX_CACHE_ENTRIES = 2000;

const translateRateLimit = createRateLimiter({
  windowMs: 60_000,
  // 30→60 (2026-06-18): the client now translates INCREMENTALLY (only changed
  // subtrees, not a full re-walk per mutation) and skips high-churn numeric
  // status strings, so legitimate usage makes far fewer calls — but a first
  // full-page translate of a busy UI still needs a couple of batches; 60 gives
  // headroom without making LLM spend easy to trigger. Client also self-backs-off
  // ~12s on a 429 (game-language-control.tsx rateLimitedUntil).
  maxPerWindow: 60,
});

const localeSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[a-zA-Z]{2,3}([_-][a-zA-Z0-9]{2,8}){0,3}$/);

const bodySchema = z.object({
  targetLocale: localeSchema,
  entries: z
    .array(
      z.object({
        id: z.string().min(1).max(128).optional(),
        text: z.string().min(1).max(MAX_TEXT_CHARS),
      }),
    )
    .min(1)
    .max(MAX_ENTRIES_PER_REQUEST),
});

interface TranslationCacheEntry {
  text: string;
  touchedAt: number;
}

const translationCache = new Map<string, TranslationCacheEntry>();

function isEnglishLocale(locale: string): boolean {
  return /^en(?:-|_|$)/i.test(locale);
}

function cacheKey(locale: string, text: string): string {
  return `${locale.toLowerCase()}:${text}`;
}

function setCachedTranslation(locale: string, source: string, translated: string) {
  if (translationCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTouchedAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of translationCache) {
      if (entry.touchedAt < oldestTouchedAt) {
        oldestKey = key;
        oldestTouchedAt = entry.touchedAt;
      }
    }
    if (oldestKey) translationCache.delete(oldestKey);
  }
  translationCache.set(cacheKey(locale, source), {
    text: translated,
    touchedAt: Date.now(),
  });
}

function getCachedTranslation(locale: string, source: string): string | null {
  const entry = translationCache.get(cacheKey(locale, source));
  if (!entry) return null;
  entry.touchedAt = Date.now();
  return entry.text;
}

function languageNameFor(locale: string): string {
  try {
    const normalized = locale.replace('_', '-');
    const languageCode = normalized.split('-')[0] ?? normalized;
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(languageCode) ?? normalized;
  } catch {
    return locale;
  }
}

i18nRoutes.post('/translate', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!translateRateLimit.check(`i18n:${ip}`)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: 'Invalid request body', detail: String(err) }, 400);
  }

  const targetLocale = parsed.targetLocale.replace('_', '-');
  if (isEnglishLocale(targetLocale)) {
    return c.json({
      targetLocale,
      translations: parsed.entries.map((entry) => ({
        id: entry.id,
        text: entry.text,
      })),
    });
  }

  const translations = parsed.entries.map((entry) => ({
    id: entry.id,
    text: getCachedTranslation(targetLocale, entry.text) ?? '',
  }));
  const uncached = parsed.entries
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => translations[entry.index].text.length === 0);

  if (uncached.length === 0) {
    return c.json({ targetLocale, translations });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'LLM not configured' }, 503);
  }

  const targetLanguage = languageNameFor(targetLocale);
  const totalChars = uncached.reduce((sum, entry) => sum + entry.text.length, 0);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        max_completion_tokens: Math.min(6000, Math.max(800, totalChars * 3)),
        messages: [
          {
            role: 'system',
            content:
              'You translate browser game UI strings. Return strict JSON only: {"translations":[{"index":number,"text":string}]}. ' +
              'Keep the same array length and indexes. Preserve product names, URLs, keyboard keys, token symbols, numbers, emoji, placeholders, and code-like tokens. ' +
              'Do not add explanations.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              targetLocale,
              targetLanguage,
              entries: uncached.map((entry) => ({
                index: entry.index,
                text: entry.text,
              })),
            }),
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[i18n] OpenAI ${res.status}: ${errText.slice(0, 200)}`);
      return c.json({ error: 'LLM upstream error' }, 502);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return c.json({ error: 'LLM returned empty response' }, 502);
    }

    const parsedOutput = JSON.parse(content) as {
      translations?: Array<{ index?: number; text?: string }>;
    };

    for (const item of parsedOutput.translations ?? []) {
      if (typeof item.index !== 'number') continue;
      if (typeof item.text !== 'string' || !item.text.trim()) continue;
      const source = parsed.entries[item.index];
      if (!source) continue;
      const translated = item.text.trim();
      translations[item.index] = {
        id: source.id,
        text: translated,
      };
      setCachedTranslation(targetLocale, source.text, translated);
    }

    for (const entry of uncached) {
      if (!translations[entry.index].text) {
        translations[entry.index] = {
          id: entry.id,
          text: entry.text,
        };
      }
    }

    return c.json({ targetLocale, translations });
  } catch (err) {
    console.error('[i18n] translation failed:', err);
    return c.json({ error: 'Translation failed' }, 502);
  }
});
