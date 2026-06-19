'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Languages, Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useIsMobile } from '@/hooks/use-is-mobile';

const STORAGE_KEY = 'clawville-game-language';
const SKIP_SELECTOR =
  'script,style,noscript,canvas,svg,input,textarea,select,option,[data-no-translate],[data-game-language-control]';
const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'] as const;
const BATCH_SIZE = 80;
const MAX_TEXT_CHARS = 600;
// S9 — cap the per-session client translation cache so unique chat/toast strings
// can't grow the Map unboundedly (oldest-evicted, FIFO).
const CLIENT_CACHE_MAX = 3000;

type TranslatableAttr = (typeof TRANSLATABLE_ATTRS)[number];

interface TextRecord {
  source: string;
  apply: (translated: string) => void;
}

// The server translates to ANY valid BCP-47 locale via the LLM + Intl.DisplayNames,
// so this list is purely the UI menu — kept broad (top world languages by speakers
// + major game markets). Native `<select>` gives free type-ahead on desktop and is
// mobile-safe. Grouped roughly by region for scannability.
const COMMON_LOCALES = [
  { code: 'es',    label: 'Spanish — Español' },
  { code: 'zh-CN', label: 'Chinese (Simplified) — 简体中文' },
  { code: 'zh-TW', label: 'Chinese (Traditional) — 繁體中文' },
  { code: 'hi',    label: 'Hindi — हिन्दी' },
  { code: 'ar',    label: 'Arabic — العربية' },
  { code: 'pt-BR', label: 'Portuguese (Brazil) — Português' },
  { code: 'pt-PT', label: 'Portuguese (Portugal) — Português' },
  { code: 'fr',    label: 'French — Français' },
  { code: 'de',    label: 'German — Deutsch' },
  { code: 'ja',    label: 'Japanese — 日本語' },
  { code: 'ko',    label: 'Korean — 한국어' },
  { code: 'ru',    label: 'Russian — Русский' },
  { code: 'it',    label: 'Italian — Italiano' },
  { code: 'tr',    label: 'Turkish — Türkçe' },
  { code: 'vi',    label: 'Vietnamese — Tiếng Việt' },
  { code: 'th',    label: 'Thai — ไทย' },
  { code: 'id',    label: 'Indonesian — Bahasa Indonesia' },
  { code: 'ms',    label: 'Malay — Bahasa Melayu' },
  { code: 'fil',   label: 'Filipino — Tagalog' },
  { code: 'nl',    label: 'Dutch — Nederlands' },
  { code: 'pl',    label: 'Polish — Polski' },
  { code: 'uk',    label: 'Ukrainian — Українська' },
  { code: 'ro',    label: 'Romanian — Română' },
  { code: 'el',    label: 'Greek — Ελληνικά' },
  { code: 'cs',    label: 'Czech — Čeština' },
  { code: 'sv',    label: 'Swedish — Svenska' },
  { code: 'da',    label: 'Danish — Dansk' },
  { code: 'fi',    label: 'Finnish — Suomi' },
  { code: 'nb',    label: 'Norwegian — Norsk' },
  { code: 'hu',    label: 'Hungarian — Magyar' },
  { code: 'he',    label: 'Hebrew — עברית' },
  { code: 'fa',    label: 'Persian — فارسی' },
  { code: 'ur',    label: 'Urdu — اردو' },
  { code: 'bn',    label: 'Bengali — বাংলা' },
  { code: 'ta',    label: 'Tamil — தமிழ்' },
  { code: 'te',    label: 'Telugu — తెలుగు' },
  { code: 'mr',    label: 'Marathi — मराठी' },
  { code: 'sw',    label: 'Swahili — Kiswahili' },
  { code: 'sr',    label: 'Serbian — Српски' },
  { code: 'hr',    label: 'Croatian — Hrvatski' },
  { code: 'sk',    label: 'Slovak — Slovenčina' },
  { code: 'bg',    label: 'Bulgarian — Български' },
  { code: 'en-US', label: 'English (no translation)' },
] as const;

function isEnglishLocale(locale: string): boolean {
  return /^en(?:-|_|$)/i.test(locale);
}

function normalizeLocale(locale: string): string {
  return locale.replace('_', '-');
}

function hasLetters(value: string): boolean {
  return /\p{L}/u.test(value);
}

// High-churn status strings (counters, timers, "6 / 12 visited", "1,250 CT",
// "Lv 3 · 0 SKILLS") change constantly → every change is a fresh cache miss →
// API spam → 30/min rate-limit trip → stalls + flicker. Skip them: they're mostly
// numbers/punctuation and re-translating them adds nothing. Conservative so it
// never drops a real label like "Press E", "Talk to Nori", "Level".
function isDynamicStatusText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length > 32) return false; // long = prose, translate it
  const digits = (trimmed.match(/\p{N}/gu) ?? []).length;
  if (digits === 0) return false; // no numbers = not a counter
  const letters = (trimmed.match(/\p{L}/gu) ?? []).length;
  const words = trimmed.match(/\p{L}+/gu)?.length ?? 0;
  // Starts with a number + ≤2 words + a separator like / : . % → "6/12 visited".
  if (/^\s*[\p{N}]/u.test(trimmed) && words <= 2 && /[/:.%·,]/.test(trimmed)) return true;
  // Numerically dominated overall (≥60% digits vs letters) → "1,250", "0/30".
  if (digits / Math.max(1, digits + letters) >= 0.6) return true;
  // Middot-joined status with live numbers → "LV 1 · 0 SKILLS", "Lv 2 · 340 XP"
  // (digits>0 already guaranteed above). Churns as stats tick.
  if (/·/.test(trimmed) && words <= 3) return true;
  return false;
}

function isTranslatableText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_TEXT_CHARS) return false;
  if (!hasLetters(trimmed)) return false;
  if (/^[A-Z0-9_/.:%#-]{1,6}$/.test(trimmed)) return false;
  if (isDynamicStatusText(trimmed)) return false;
  return true;
}

function shouldSkip(node: Node): boolean {
  const parent =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return !!parent?.closest(SKIP_SELECTOR);
}

function displayNameForLocale(locale: string): string {
  try {
    const normalized = normalizeLocale(locale);
    const languageCode = normalized.split('-')[0] ?? normalized;
    return new Intl.DisplayNames([normalized, 'en'], { type: 'language' }).of(languageCode) ?? normalized;
  } catch {
    return locale;
  }
}

export default function GameLanguageControl() {
  const isMobile = useIsMobile();
  const [browserLocale, setBrowserLocale] = useState('en-US');
  const [selection, setSelection] = useState('auto');
  const [panelOpen, setPanelOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [translatedCount, setTranslatedCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);

  const originalText = useRef(new WeakMap<Text, string>());
  const appliedText = useRef(new WeakMap<Text, string>());
  const trackedTextNodes = useRef(new Set<Text>());
  const originalAttrs = useRef(new WeakMap<Element, Partial<Record<TranslatableAttr, string>>>());
  const appliedAttrs = useRef(new WeakMap<Element, Partial<Record<TranslatableAttr, string>>>());
  const trackedAttrElements = useRef(new Set<Element>());
  const clientCache = useRef(new Map<string, string>());
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  // Incremental work queue — nodes the observer saw change/added, drained by flushPending.
  const pendingNodes = useRef(new Set<Node>());
  // 429 backoff — after a rate-limit, apply only cached strings (no API) until this passes.
  const rateLimitedUntil = useRef(0);

  useEffect(() => {
    const detected = normalizeLocale(navigator.language || 'en-US');
    setBrowserLocale(detected);
    setSelection(localStorage.getItem(STORAGE_KEY) || 'auto');
  }, []);

  const targetLocale = useMemo(() => {
    return selection === 'auto' ? browserLocale : normalizeLocale(selection);
  }, [browserLocale, selection]);

  const translationActive = !!targetLocale && !isEnglishLocale(targetLocale);

  const cacheKeyFor = useCallback((text: string) => {
    return `${targetLocale.toLowerCase()}:${text}`;
  }, [targetLocale]);

  // S9/S8 — drop disconnected nodes so the tracked Sets (which hold STRONG refs)
  // stay bounded to LIVE nodes. Without this they grow forever during a
  // translation-active session (chat/toasts/labels churning the DOM) → heap
  // bloat + an ever-slower restoreOriginals/collect pass = a freeze vector.
  // Deleting during for..of a Set is safe. WeakMap originals are left intact —
  // GC reclaims them once the Set ref drops, and they're preserved if React
  // reconnects the same node.
  const pruneDisconnectedTracked = useCallback(() => {
    for (const node of trackedTextNodes.current) {
      if (!node.isConnected) trackedTextNodes.current.delete(node);
    }
    for (const element of trackedAttrElements.current) {
      if (!element.isConnected) trackedAttrElements.current.delete(element);
    }
  }, []);

  // S9 — bounded client cache writer (oldest-evicted) so unique chat/toast
  // strings can't grow the Map without limit across a long session.
  const setClientCache = useCallback((key: string, value: string) => {
    const cache = clientCache.current;
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > CLIENT_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }, []);

  const restoreOriginals = useCallback(() => {
    pruneDisconnectedTracked();
    for (const node of trackedTextNodes.current) {
      const original = originalText.current.get(node);
      if (node.isConnected && original != null && node.textContent !== original) {
        node.textContent = original;
      }
      appliedText.current.delete(node);
    }

    for (const element of trackedAttrElements.current) {
      if (!element.isConnected) continue;
      const originals = originalAttrs.current.get(element);
      if (!originals) continue;
      for (const attr of TRANSLATABLE_ATTRS) {
        const original = originals[attr];
        if (original != null && element.getAttribute(attr) !== original) {
          element.setAttribute(attr, original);
        }
      }
      appliedAttrs.current.delete(element);
    }

    setTranslatedCount(0);
  }, [pruneDisconnectedTracked]);

  const getTextOriginal = useCallback((node: Text) => {
    const current = node.textContent ?? '';
    const original = originalText.current.get(node);
    const applied = appliedText.current.get(node);
    // Recapture the English source when: first sight (original==null), OR the node
    // changed to NEW content (current!==original) that is NOT our own applied
    // translation. `applied==null` is the key audit-fix case: a node that was
    // tracked but never translated (dynamic-skipped / rate-limited) and that React
    // later fills with real text — without this it returns the stale source and
    // the new text is never translated.
    if (original == null || (current !== original && (applied == null || current !== applied))) {
      originalText.current.set(node, current);
      trackedTextNodes.current.add(node);
      appliedText.current.delete(node);
      return current;
    }
    // S9 — re-track even when the original is already known, so a node that was
    // pruned while disconnected is re-registered when seen again and stays
    // restorable. Set.add is idempotent.
    trackedTextNodes.current.add(node);
    return original;
  }, []);

  const getAttrOriginal = useCallback((element: Element, attr: TranslatableAttr) => {
    const current = element.getAttribute(attr) ?? '';
    const originals = originalAttrs.current.get(element) ?? {};
    const applied = appliedAttrs.current.get(element)?.[attr];
    // Same recapture rule as getTextOriginal (audit fix): recapture on first sight
    // OR when the attr changed to new content that isn't our applied translation.
    if (originals[attr] == null || (current !== originals[attr] && (applied == null || current !== applied))) {
      originals[attr] = current;
      originalAttrs.current.set(element, originals);
      trackedAttrElements.current.add(element);
      const appliedMap = appliedAttrs.current.get(element) ?? {};
      delete appliedMap[attr];
      appliedAttrs.current.set(element, appliedMap);
      return current;
    }
    // S9 — re-track (see getTextOriginal) so a reconnected element stays restorable.
    trackedAttrElements.current.add(element);
    return originals[attr] ?? current;
  }, []);

  // --- Record builders (shared by full scan + incremental) ---
  const makeTextRecord = useCallback((node: Text): TextRecord | null => {
    if (shouldSkip(node)) return null;
    const source = getTextOriginal(node);
    if (!isTranslatableText(source)) return null;
    return {
      source,
      apply: (translated) => {
        if (!node.isConnected || shouldSkip(node)) return;
        if (node.textContent !== translated) node.textContent = translated;
        appliedText.current.set(node, translated);
      },
    };
  }, [getTextOriginal]);

  const collectAttrRecords = useCallback((element: Element, out: TextRecord[]) => {
    if (shouldSkip(element)) return;
    for (const attr of TRANSLATABLE_ATTRS) {
      if (!element.hasAttribute(attr)) continue;
      const source = getAttrOriginal(element, attr);
      if (!isTranslatableText(source)) continue;
      out.push({
        source,
        apply: (translated) => {
          if (!element.isConnected || shouldSkip(element)) return;
          if (element.getAttribute(attr) !== translated) element.setAttribute(attr, translated);
          const applied = appliedAttrs.current.get(element) ?? {};
          applied[attr] = translated;
          appliedAttrs.current.set(element, applied);
        },
      });
    }
  }, [getAttrOriginal]);

  // FULL scan — initial pass + language switch only.
  const collectRecords = useCallback((): TextRecord[] => {
    const root = document.querySelector('.game-container');
    if (!root) return [];
    const records: TextRecord[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (shouldSkip(node)) return NodeFilter.FILTER_REJECT;
        const source = getTextOriginal(node as Text);
        return isTranslatableText(source) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let textNode = walker.nextNode() as Text | null;
    while (textNode) {
      const rec = makeTextRecord(textNode);
      if (rec) records.push(rec);
      textNode = walker.nextNode() as Text | null;
    }
    for (const attr of TRANSLATABLE_ATTRS) {
      root.querySelectorAll(`[${attr}]`).forEach((el) => collectAttrRecords(el, records));
    }
    return records;
  }, [getTextOriginal, makeTextRecord, collectAttrRecords]);

  // INCREMENTAL scan — only the subtree of a changed/added node (observer path).
  const collectRecordsFromNode = useCallback((node: Node, out: TextRecord[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const rec = makeTextRecord(node as Text);
      if (rec) out.push(rec);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.closest(SKIP_SELECTOR)) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (shouldSkip(n)) return NodeFilter.FILTER_REJECT;
        const source = getTextOriginal(n as Text);
        return isTranslatableText(source) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let tn = walker.nextNode() as Text | null;
    while (tn) {
      const rec = makeTextRecord(tn);
      if (rec) out.push(rec);
      tn = walker.nextNode() as Text | null;
    }
    collectAttrRecords(el, out);
    for (const attr of TRANSLATABLE_ATTRS) {
      el.querySelectorAll(`[${attr}]`).forEach((d) => collectAttrRecords(d, out));
    }
  }, [getTextOriginal, makeTextRecord, collectAttrRecords]);

  // Shared translate — dedupe by source, batch uncached to the API, cache, apply.
  // `seq` is the generation captured by the caller; bails after each await if a
  // language switch / disable bumped requestSeq. Does NOT bump requestSeq itself.
  const translateRecords = useCallback(async (records: TextRecord[], seq: number): Promise<number> => {
    if (records.length === 0) return 0;
    const bySource = new Map<string, TextRecord[]>();
    for (const record of records) {
      const arr = bySource.get(record.source);
      if (arr) arr.push(record); else bySource.set(record.source, [record]);
    }
    // Rate-limit backoff — apply only what's already cached, skip the API.
    if (Date.now() < rateLimitedUntil.current) {
      let n = 0;
      for (const [source, recs] of bySource) {
        const cached = clientCache.current.get(cacheKeyFor(source));
        if (!cached) continue;
        for (const r of recs) { r.apply(cached); n += 1; }
      }
      return n;
    }
    const uniqueSources = Array.from(bySource.keys());
    let appliedCount = 0;
    setLoading(true);
    try {
      for (let offset = 0; offset < uniqueSources.length; offset += BATCH_SIZE) {
        if (seq !== requestSeq.current) return appliedCount;
        const chunk = uniqueSources.slice(offset, offset + BATCH_SIZE);
        const uncached = chunk.filter((source) => !clientCache.current.has(cacheKeyFor(source)));
        if (uncached.length > 0) {
          let res;
          try {
            res = await api.translateGameText(
              targetLocale,
              uncached.map((text, index) => ({ id: String(index), text })),
            );
          } catch (err: any) {
            // 429 → back off ~12s so the observer doesn't hammer retries; cached
            // strings + the fast-reapply path keep working during the backoff.
            if (err?.status === 429 || err?.code === 'rate_limited' || /rate.?limit/i.test(err?.message ?? '')) {
              rateLimitedUntil.current = Date.now() + 12_000;
            }
            throw err;
          }
          // Stale-guard: a language switch / disable mid-flight bumped requestSeq →
          // do NOT cache or apply (would flash/persist the wrong locale).
          if (seq !== requestSeq.current) return appliedCount;
          res.translations.forEach((entry, index) => {
            const source = uncached[index];
            if (!source || !entry.text) return;
            setClientCache(cacheKeyFor(source), entry.text);
          });
        }
        for (const source of chunk) {
          const translated = clientCache.current.get(cacheKeyFor(source));
          if (!translated) continue;
          for (const record of bySource.get(source) ?? []) {
            record.apply(translated);
            appliedCount += 1;
          }
        }
      }
      setLastError(null);
      return appliedCount;
    } catch (err: any) {
      setLastError(err?.message || 'Translation failed');
      return appliedCount;
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [cacheKeyFor, setClientCache, targetLocale]);

  // FULL pass — opens a new generation (cancels in-flight work). Init + lang switch.
  const translateVisibleText = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLastError(null);
    if (!translationActive) { restoreOriginals(); return; }
    pruneDisconnectedTracked();
    const applied = await translateRecords(collectRecords(), seq);
    if (seq === requestSeq.current) setTranslatedCount(applied);
  }, [translationActive, restoreOriginals, pruneDisconnectedTracked, collectRecords, translateRecords]);

  // INCREMENTAL flush — drains the observer's pending-node queue within the
  // CURRENT generation (no requestSeq bump). Cheap: only changed subtrees.
  const flushPending = useCallback(async () => {
    if (!translationActive) { pendingNodes.current.clear(); return; }
    const nodes = Array.from(pendingNodes.current);
    pendingNodes.current.clear();
    if (nodes.length === 0) return;
    const seq = requestSeq.current;
    const records: TextRecord[] = [];
    for (const n of nodes) { if (n.isConnected) collectRecordsFromNode(n, records); }
    const applied = await translateRecords(records, seq);
    if (applied > 0 && seq === requestSeq.current) setTranslatedCount((c) => c + applied);
  }, [translationActive, collectRecordsFromNode, translateRecords]);

  const scheduleFullTranslate = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => { void translateVisibleText(); }, 150);
  }, [translateVisibleText]);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => { void flushPending(); }, 120);
  }, [flushPending]);

  useEffect(() => {
    const root = document.querySelector('.game-container');
    if (!root) return;

    // Initial pass + language switch (deps change → effect re-runs).
    scheduleFullTranslate();

    const observer = new MutationObserver((mutations) => {
      if (!translationActive) return; // English: nothing to do
      let queued = false;
      for (const m of mutations) {
        const tgt = m.target;
        // Ignore our own control UI.
        if (tgt instanceof Element && tgt.closest('[data-game-language-control]')) continue;
        if (tgt instanceof Text && tgt.parentElement?.closest('[data-game-language-control]')) continue;

        if (m.type === 'characterData' && tgt.nodeType === Node.TEXT_NODE) {
          const node = tgt as Text;
          const current = node.textContent ?? '';
          const applied = appliedText.current.get(node);
          if (applied != null && current === applied) continue; // our own write
          const original = originalText.current.get(node);
          if (original != null && current === original) {
            // React reverted a known node back to English → re-apply the cached
            // translation SYNCHRONOUSLY (no debounce, no API) so it never flashes.
            const cached = clientCache.current.get(cacheKeyFor(original));
            if (cached && cached !== current) {
              node.textContent = cached;
              appliedText.current.set(node, cached);
              continue;
            }
          }
          pendingNodes.current.add(node); queued = true;
        } else if (m.type === 'attributes' && tgt instanceof Element && m.attributeName) {
          const el = tgt;
          const attr = m.attributeName as TranslatableAttr;
          if (!(TRANSLATABLE_ATTRS as readonly string[]).includes(attr)) continue;
          const current = el.getAttribute(attr) ?? '';
          const applied = appliedAttrs.current.get(el)?.[attr];
          if (applied != null && current === applied) continue; // our own write
          const original = originalAttrs.current.get(el)?.[attr];
          if (original != null && current === original) {
            const cached = clientCache.current.get(cacheKeyFor(original));
            if (cached && cached !== current) {
              el.setAttribute(attr, cached);
              const map = appliedAttrs.current.get(el) ?? {};
              map[attr] = cached;
              appliedAttrs.current.set(el, map);
              continue;
            }
          }
          pendingNodes.current.add(el); queued = true;
        } else if (m.type === 'childList') {
          m.addedNodes.forEach((n) => { pendingNodes.current.add(n); queued = true; });
        }
      }
      if (queued) scheduleFlush();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRS],
    });

    return () => {
      observer.disconnect();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (flushTimer.current) clearTimeout(flushTimer.current);
      pendingNodes.current.clear();
      requestSeq.current += 1;
    };
  }, [scheduleFullTranslate, scheduleFlush, translationActive, cacheKeyFor]);

  const setLanguage = (value: string) => {
    setSelection(value);
    localStorage.setItem(STORAGE_KEY, value);
  };

  const buttonLabel = translationActive
    ? displayNameForLocale(targetLocale)
    : 'English';

  return (
    <div
      data-game-language-control
      data-no-translate
      className="fixed z-50"
      style={isMobile
        ? {
            top: 'calc(env(safe-area-inset-top, 0px) + 128px)',
            left: 'calc(env(safe-area-inset-left, 0px) + 12px)',
          }
        : {
            // Desktop: icon-only, side by side with the Controls icon under
            // the (shortened) right sidebar — Controls at right:16, this at
            // right:68 (44px icon + 8px gap). Was bottom-left 16px, which
            // covered the inventory/demo panel.
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
            right: 68,
          }}
    >
      <button
        type="button"
        onClick={() => setPanelOpen((open) => !open)}
        className="flex h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-emerald-300/45 bg-[#052f2d]/90 px-3 text-emerald-50 shadow-[0_0_24px_rgba(52,211,153,0.22)] backdrop-blur-md transition-all hover:border-emerald-200/80 hover:bg-[#06423f] active:translate-y-0.5"
        aria-label="Open language controls"
        title={`Language — ${buttonLabel}`}
      >
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        ) : (
          <Languages className="h-5 w-5" aria-hidden />
        )}
      </button>

      {panelOpen && (
        <div
          className={`absolute ${isMobile ? 'left-0' : 'right-0'} w-72 overflow-hidden rounded-lg border border-emerald-200/24 bg-[#071c23]/96 p-3 text-emerald-50 shadow-[0_18px_70px_rgba(0,0,0,0.42)] backdrop-blur-md`}
          style={isMobile ? { top: 52 } : { bottom: 52 }}
        >
          <div className="mb-3 flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-emerald-200/24 bg-emerald-300/10">
              <Languages className="h-4 w-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] font-black uppercase tracking-[0.18em] text-emerald-200/70">
                Game Language
              </div>
              <div className="text-sm text-emerald-50/78">
                Visible game text translates as panels and chat appear.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 text-white/70 hover:border-white/25 hover:text-white"
              aria-label="Close language controls"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <label className="block text-xs font-bold uppercase tracking-[0.14em] text-emerald-100/70">
            Translate to
          </label>
          <select
            value={selection}
            onChange={(event) => setLanguage(event.target.value)}
            className="mt-1 w-full rounded-md border border-emerald-200/20 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-200/60"
          >
            <option value="auto">Browser language ({browserLocale})</option>
            {COMMON_LOCALES.map((locale) => (
              <option key={locale.code} value={locale.code}>
                {locale.label}
              </option>
            ))}
          </select>

          <div className="mt-3 flex items-center gap-2 text-xs text-emerald-100/68">
            {translationActive ? (
              <>
                <Check className="h-4 w-4 text-emerald-300" aria-hidden />
                <span>{translatedCount > 0 ? `${translatedCount} strings translated` : 'Ready to translate visible text'}</span>
              </>
            ) : (
              <span>English text is shown without translation.</span>
            )}
          </div>
          {lastError && (
            <div className="mt-2 rounded-md border border-red-300/25 bg-red-950/35 px-2 py-1.5 text-xs text-red-100/85">
              {lastError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
