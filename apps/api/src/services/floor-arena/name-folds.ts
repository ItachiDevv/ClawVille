/**
 * Arena reserved-name folds that are NOT in UTS #39, added because they impersonate in practice
 * (lead, after Codex r20): leetspeak digits, and the Latin small capitals that Unicode's
 * confusables list does not map to an ASCII letter (it gives ᴋ and ᴍ non-ASCII prototypes only).
 * 0 -> O and 1 -> l come from Unicode itself.
 *
 * Used by names.ts (applied to every Unicode prototype, so a character whose prototype is one of
 * these keys chains through it: Cyrillic small en -> ʜ -> h) and by
 * apps/api/scripts/floor-arena/generate-confusables.ts (keeps the Unicode entries whose prototype
 * uses these keys). After a change here, re-run the generator; a test pins the two in sync.
 */
export const FLOOR_ARENA_EXTRA_FOLDS: Readonly<Record<string, string>> = Object.freeze({
  '3': 'e', '4': 'a', '5': 's', '7': 't', '9': 'g',
  'ᴀ': 'a', 'ʙ': 'b', 'ᴅ': 'd', 'ᴇ': 'e', 'ɢ': 'g', 'ʜ': 'h', 'ᴊ': 'j',
  'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴘ': 'p', 'ʀ': 'r', 'ᴛ': 't',
});
