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

type TranslatableAttr = (typeof TRANSLATABLE_ATTRS)[number];

interface TextRecord {
  source: string;
  apply: (translated: string) => void;
}

const COMMON_LOCALES = [
  { code: 'en-US', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt-BR', label: 'Portuguese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh-CN', label: 'Chinese' },
  { code: 'hi', label: 'Hindi' },
  { code: 'tr', label: 'Turkish' },
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

function isTranslatableText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_TEXT_CHARS) return false;
  if (!hasLetters(trimmed)) return false;
  if (/^[A-Z0-9_/.:%#-]{1,6}$/.test(trimmed)) return false;
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
  const suppressObserverUntil = useRef(0);
  const requestSeq = useRef(0);

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

  const restoreOriginals = useCallback(() => {
    suppressObserverUntil.current = Date.now() + 350;
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
  }, []);

  const getTextOriginal = useCallback((node: Text) => {
    const current = node.textContent ?? '';
    const original = originalText.current.get(node);
    const applied = appliedText.current.get(node);
    if (original == null || (applied && current !== applied && current !== original)) {
      originalText.current.set(node, current);
      trackedTextNodes.current.add(node);
      appliedText.current.delete(node);
      return current;
    }
    return original;
  }, []);

  const getAttrOriginal = useCallback((element: Element, attr: TranslatableAttr) => {
    const current = element.getAttribute(attr) ?? '';
    const originals = originalAttrs.current.get(element) ?? {};
    const applied = appliedAttrs.current.get(element)?.[attr];
    if (originals[attr] == null || (applied && current !== applied && current !== originals[attr])) {
      originals[attr] = current;
      originalAttrs.current.set(element, originals);
      trackedAttrElements.current.add(element);
      const appliedMap = appliedAttrs.current.get(element) ?? {};
      delete appliedMap[attr];
      appliedAttrs.current.set(element, appliedMap);
      return current;
    }
    return originals[attr] ?? current;
  }, []);

  const collectRecords = useCallback((): TextRecord[] => {
    const root = document.querySelector('.game-container');
    if (!root) return [];

    const records: TextRecord[] = [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (shouldSkip(node)) return NodeFilter.FILTER_REJECT;
          const source = getTextOriginal(node as Text);
          return isTranslatableText(source)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      },
    );

    let textNode = walker.nextNode() as Text | null;
    while (textNode) {
      const node = textNode;
      const source = getTextOriginal(node);
      records.push({
        source,
        apply: (translated) => {
          if (!node.isConnected || shouldSkip(node)) return;
          if (node.textContent !== translated) node.textContent = translated;
          appliedText.current.set(node, translated);
        },
      });
      textNode = walker.nextNode() as Text | null;
    }

    for (const attr of TRANSLATABLE_ATTRS) {
      const elements = root.querySelectorAll(`[${attr}]`);
      for (const element of Array.from(elements)) {
        if (shouldSkip(element)) continue;
        const source = getAttrOriginal(element, attr);
        if (!isTranslatableText(source)) continue;
        records.push({
          source,
          apply: (translated) => {
            if (!element.isConnected || shouldSkip(element)) return;
            if (element.getAttribute(attr) !== translated) {
              element.setAttribute(attr, translated);
            }
            const applied = appliedAttrs.current.get(element) ?? {};
            applied[attr] = translated;
            appliedAttrs.current.set(element, applied);
          },
        });
      }
    }

    return records;
  }, [getAttrOriginal, getTextOriginal]);

  const translateVisibleText = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLastError(null);

    if (!translationActive) {
      restoreOriginals();
      return;
    }

    const records = collectRecords();
    if (records.length === 0) return;

    const bySource = new Map<string, TextRecord[]>();
    for (const record of records) {
      const existing = bySource.get(record.source);
      if (existing) existing.push(record);
      else bySource.set(record.source, [record]);
    }

    const uniqueSources = Array.from(bySource.keys());
    let appliedCount = 0;
    setLoading(true);

    try {
      for (let offset = 0; offset < uniqueSources.length; offset += BATCH_SIZE) {
        if (seq !== requestSeq.current) return;
        const chunk = uniqueSources.slice(offset, offset + BATCH_SIZE);
        const uncached = chunk.filter((source) => !clientCache.current.has(cacheKeyFor(source)));

        if (uncached.length > 0) {
          const res = await api.translateGameText(
            targetLocale,
            uncached.map((text, index) => ({ id: String(index), text })),
          );
          res.translations.forEach((entry, index) => {
            const source = uncached[index];
            if (!source || !entry.text) return;
            clientCache.current.set(cacheKeyFor(source), entry.text);
          });
        }

        for (const source of chunk) {
          const translated = clientCache.current.get(cacheKeyFor(source));
          if (!translated) continue;
          suppressObserverUntil.current = Date.now() + 350;
          for (const record of bySource.get(source) ?? []) {
            record.apply(translated);
            appliedCount += 1;
          }
        }
      }

      setTranslatedCount(appliedCount);
    } catch (err: any) {
      setLastError(err?.message || 'Translation failed');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [cacheKeyFor, collectRecords, restoreOriginals, targetLocale, translationActive]);

  const scheduleTranslate = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void translateVisibleText();
    }, 180);
  }, [translateVisibleText]);

  useEffect(() => {
    const root = document.querySelector('.game-container');
    if (!root) return;

    scheduleTranslate();
    const observer = new MutationObserver((mutations) => {
      if (Date.now() < suppressObserverUntil.current) return;
      if (mutations.some((mutation) => mutation.target instanceof Element && mutation.target.closest('[data-game-language-control]'))) {
        return;
      }
      scheduleTranslate();
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
      requestSeq.current += 1;
    };
  }, [scheduleTranslate]);

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
