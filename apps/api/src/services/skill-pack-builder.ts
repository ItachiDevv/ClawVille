/**
 * SkillPack builder — pure derivation of an avatar's exportable skill pack
 * from its learned knowledge.
 *
 * Extracted from `apps/api/src/routes/agent-export.ts` (2026-06-19) so BOTH
 * the "take my agent home" character export AND the new signed avatar-manifest
 * export (`avatar-manifest-service.ts`) share one definition — re-deriving the
 * pack in two places would let them silently drift.
 *
 * Pure + synchronous: no DB access (the caller passes the avatar's
 * `characterConfig.knowledge` array), so this stays trivially unit-testable.
 */
import {
  BUILDING_MILADY_SKILLS,
  KNOWLEDGE_BOOKS,
  CLAWVILLE_ORIENTATION_SKILL,
  type KnowledgeBook,
  type SkillPackEntry,
} from '@clawville/shared';

/**
 * Pre-compute the (buildingId → KnowledgeBook[]) map from the KNOWLEDGE_BOOKS
 * registry at module load. Every building maps to exactly 2 books in the
 * current spec; the fully-learned check below uses `.every(...)` so 3+
 * books per building would still work correctly (avatar would need ALL of them).
 */
const BOOKS_BY_BUILDING: Readonly<Record<string, readonly KnowledgeBook[]>> = (() => {
  const m: Record<string, KnowledgeBook[]> = {};
  for (const book of KNOWLEDGE_BOOKS) {
    (m[book.building] ??= []).push(book);
  }
  // Deep-freeze: the outer Record AND each inner array. `Object.freeze` is
  // shallow, and `KNOWLEDGE_BOOKS` is typed as `KnowledgeBook[]` (mutable),
  // so without this loop a test helper that does `BOOKS_BY_BUILDING['x']
  // .push(fakeBook)` would succeed silently and corrupt skill-pack output.
  for (const arr of Object.values(m)) Object.freeze(arr);
  return Object.freeze(m);
})();

/**
 * Compose the SkillPack for an avatar.
 *
 * "Fully learned" check — a building is learned when the avatar's
 * `characterConfig.knowledge` contains at least one entry from EACH
 * book published at that building. This mirrors the existing gate in
 * `apps/api/src/routes/items.ts` (the `export-skill/:buildingId`
 * endpoint) verbatim so the bundle matches the in-game export flow exactly.
 *
 * IMPORTANT: we intentionally DO NOT check `avatar_inventory` here. Books
 * are consumed on `POST /api/items/learn`, so any avatar that has actually
 * learned books will have an empty inventory for those book IDs — relying on
 * inventory would silently emit zero skills for every fully-trained avatar.
 *
 * The `knowledge` field on each entry is sourced from the book's
 * `knowledgeEntries` array in stable order (book-registry order, then entry
 * order within each book) so re-exporting the same avatar produces a
 * byte-identical pack — important now that the pack is signed inside a manifest.
 */
export function buildSkillPack(
  avatar: { id: string; name: string },
  avatarKnowledge: string[],
): SkillPackEntry[] {
  const knowledgeSet = new Set(avatarKnowledge);

  const entries: SkillPackEntry[] = [];

  // Always ship the ClawVille orientation skill first. Gives the exported
  // agent RAG access to modes, buildings, economy, connect/reconnect/
  // disconnect flow, and session-liveness rules on its new host.
  entries.push({
    ...CLAWVILLE_ORIENTATION_SKILL,
    exportedFrom: { avatarId: avatar.id, avatarName: avatar.name },
  });

  for (const [buildingId, skill] of Object.entries(BUILDING_MILADY_SKILLS)) {
    const buildingBooks = BOOKS_BY_BUILDING[buildingId] ?? [];
    if (buildingBooks.length === 0) continue;

    // Fully-learned check — every book assigned to this building must
    // have at least one of its entries in the avatar's knowledge set.
    const fullyLearned = buildingBooks.every((book) =>
      book.knowledgeEntries.some((entry) => knowledgeSet.has(entry)),
    );
    if (!fullyLearned) continue;

    // Flatten all knowledge chunks from this building's books in stable
    // order. We emit every chunk from the canonical registry rather than
    // just the ones the avatar currently carries — the pack ships the full
    // building skill so the consumer's RAG store sees the complete body of
    // knowledge.
    const knowledge: string[] = buildingBooks.flatMap(
      (book) => book.knowledgeEntries,
    );

    entries.push({
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      buildingId,
      knowledge,
      source: 'clawville',
      exportedFrom: { avatarId: avatar.id, avatarName: avatar.name },
    });
  }

  return entries;
}
