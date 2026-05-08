/**
 * Phase 3 — SkillPackEntry is one element of the "take my agent home"
 * bundle emitted by `POST /api/agent/export-character`.
 *
 * A SkillPack is the list of Milady-compatible skills an avatar has fully
 * learned (i.e. it owns BOTH knowledge books at a given building and
 * therefore merits the corresponding skill from `BUILDING_MILADY_SKILLS`).
 *
 * This type lives in `@clawville/shared` because it's consumed on both
 * sides: the API composes it from DB rows, and Phase 4a's UI (+ the
 * Milady plugin) reads it back. Keeping one source of truth prevents
 * drift between emitter and consumer.
 *
 * The shape intentionally mirrors `MiladySkillDefinition` (from
 * `constants/milady-skills.ts`) with two additions:
 *   - `knowledge`: the markdown-per-chunk strings copied from the avatar's
 *     `characterConfig.knowledge[]` for the relevant buildings so the
 *     Milady plugin can seed the newly installed character's RAG store
 *     without another round-trip back to ClawVille.
 *   - `exportedFrom`: provenance so the installing agent can display
 *     "imported from <avatarName>" and honour any future attribution rules.
 *
 * We deliberately DO NOT sign or hash the entry in Phase 3; see §11 of
 * the plan doc for the rationale. A future `signature` field can be
 * added later without breaking existing consumers.
 */
export interface SkillPackEntry {
  /** Stable skill id from `BUILDING_MILADY_SKILLS[buildingId].skillId` */
  skillId: string;
  /** Human-readable skill name (e.g. "Automation & Scheduling") */
  name: string;
  /** Short description copied verbatim from the skill definition */
  description: string;
  /** Milady skill category (e.g. "Automation & Workflows") */
  category: string;
  /** ClawVille building id that unlocked this skill */
  buildingId: string;
  /**
   * Markdown-per-chunk knowledge the avatar learned from this building's
   * books. Each string is one RAG-sized chunk; Milady is expected to
   * embed them on install. Order is stable: book order in
   * `KNOWLEDGE_BOOKS`, then entry order within each book.
   */
  knowledge: string[];
  /**
   * Always `'clawville'` for Phase 3 exports. Leaves room for third
   * parties to later emit SkillPackEntry-shaped payloads through the
   * same install channel if the skill marketplace grows.
   */
  source: 'clawville';
  /** Provenance — which avatar (on which ClawVille instance) issued this entry */
  exportedFrom: {
    avatarId: string;
    avatarName: string;
  };
}
