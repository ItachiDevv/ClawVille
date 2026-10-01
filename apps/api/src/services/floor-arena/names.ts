import { FLOOR_ARENA_HOUSE_AGENTS } from '@clawville/shared';
import { FLOOR_ARENA_CONFUSABLES } from './confusables.generated';
import { FLOOR_ARENA_EXTRA_FOLDS } from './name-folds';

/**
 * Reserved arena names (audit-contest NIT, lead 2026-09-30; Codex r19/r20): a user agent may not
 * take a house agent's display name, so a player cannot pass as a house agent on the board or the
 * tape. Launch (the only write of a user agent's name) answers 400 `name_reserved` (manual §17c).
 *
 * A name is reserved when its key equals a house name's key. The look-alike data is Unicode's own
 * confusables list (UTS #39, generated into confusables.generated.ts) plus the small, named
 * FLOOR_ARENA_EXTRA_FOLDS (name-folds.ts: leetspeak digits, Latin small capitals).
 */

/** Each exact character to its Unicode prototype, then every prototype character through the extra folds. */
function mapConfusables(text: string): string {
  let out = '';
  for (const ch of text) {
    for (const proto of FLOOR_ARENA_CONFUSABLES[ch] ?? ch) out += FLOOR_ARENA_EXTRA_FOLDS[proto] ?? proto;
  }
  return out;
}

/**
 * The comparison key of a display name:
 * 1. NFKC (full-width, mathematical and other compatibility letters), then NFD and removal of
 *    combining marks (accents).
 * 2. Every EXACT character to its Unicode prototype, before any case change, so a capital is read
 *    by its own shape (Greek capital Nu reads as N; only small nu reads as v); then each prototype
 *    character through the extra folds (Cyrillic small en -> ʜ -> h, 3 -> e).
 * 3. Case is ignored: ASCII letters to lower case (a non-ASCII letter keeps its exact shape), then
 *    the table again, so an upper-case M also becomes rn like m.
 * 4. Unicode lists capital I as a look-alike of l; with case ignored, I and i are one letter, so
 *    i and l are one letter in the key.
 * 5. Only letters and digits stay (spaces, punctuation, dashes and zero-width characters go).
 */
export function floorArenaNameKey(name: string): string {
  const base = name.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '');
  const exact = mapConfusables(base);
  const folded = mapConfusables(exact.replace(/[A-Z]/g, (ch) => ch.toLowerCase()));
  return folded.replace(/i/g, 'l').replace(/[^\p{L}\p{N}]/gu, '');
}

const RESERVED_KEYS: ReadonlySet<string> = new Set(FLOOR_ARENA_HOUSE_AGENTS.map((house) => floorArenaNameKey(house.name)));

/** True when `name` reads as a house agent's display name. */
export function isFloorArenaReservedName(name: string): boolean {
  const key = floorArenaNameKey(name);
  return key.length > 0 && RESERVED_KEYS.has(key);
}
