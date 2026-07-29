import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const CAPACITY_IDENTIFIERS = Object.freeze([
  'MAX_CARD_QUADS',
  'HOLDEM_PARITY_SLOT_CAP',
  'BLACKJACK_PARITY_SLOT_CAP',
  'BACCARAT_PARITY_SLOT_CAP',
] as const);

function extractBalancedFunction(source: string, functionName: string): string {
  const functionIndex = source.indexOf(`function ${functionName}`);
  if (functionIndex < 0) throw new Error(`Missing function ${functionName}`);
  const open = source.indexOf('{', functionIndex);
  if (open < 0) throw new Error(`Missing body for ${functionName}`);
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(functionIndex, index + 1);
    }
  }
  throw new Error(`Unbalanced body for ${functionName}`);
}

export function extractAtlasSpan(source: string): string {
  const start = /\bconst\s+ATLAS_CELL_WIDTH\b/.exec(source)?.index ?? -1;
  if (start < 0) throw new Error('Missing ATLAS_CELL_WIDTH');
  const append = extractBalancedFunction(source, 'appendCardQuad');
  const appendStart = source.indexOf('function appendCardQuad');
  return `${source.slice(start, appendStart)}${append}`;
}

export function stripComments(source: string): string {
  let output = '';
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (
        index < source.length
        && !(source[index] === '*' && source[index + 1] === '/')
      ) {
        if (source[index] === '\n') output += '\n';
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function stripWhitelistedCapacityDelta(source: string): string {
  let result = source;
  for (const identifier of CAPACITY_IDENTIFIERS) {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result
      .replace(new RegExp(
        `^\\s*(?:export\\s+)?const\\s+${escaped}\\s*=.*?;\\s*$`,
        'gm',
      ), '')
      .replace(new RegExp(
        `^\\s*if\\s*\\([^\\n]*>=\\s*${escaped}[^\\n]*\\)\\s*(?:return;|\\{[^\\n]*\\})\\s*$`,
        'gm',
      ), '')
      .replace(new RegExp(
        `^\\s*if\\s*\\([^\\n]*>=\\s*${escaped}[^\\n]*\\)\\s*\\{[\\s\\S]*?^\\s*\\}\\s*$`,
        'gm',
      ), '');
  }
  // Blackjack's whitelisted 64-quad guard reports overflow through this
  // guard-only callback. It is part of the capacity delta, not atlas behavior.
  result = result.replace(
    /^\s*onCardOverflow\?:\s*\(\)\s*=>\s*void,\s*$/gm,
    '',
  );
  return result;
}

/**
 * Frozen rev-4 procedure:
 * 1. extract the atlas/drawing/UV span;
 * 2. strip only whitelisted capacity declarations/guards;
 * 3. strip all comments;
 * 4. collapse whitespace and trim each line;
 * 5. normalize line endings to LF.
 */
export function normalizeAtlas(source: string): string {
  const extracted = extractAtlasSpan(source);
  const withoutCapacity = stripWhitelistedCapacityDelta(extracted);
  const withoutComments = stripComments(withoutCapacity);
  return withoutComments
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function atlasHash(source: string): string {
  return createHash('sha256').update(normalizeAtlas(source)).digest('hex');
}

export async function normalizeAtlasFile(path: string): Promise<string> {
  return normalizeAtlas(await readFile(path, 'utf8'));
}

export const ATLAS_CAPACITY_ALLOWLIST = CAPACITY_IDENTIFIERS;
