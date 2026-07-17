import { describe, it, expect } from 'bun:test';
import { MODEL_REGISTRY, type ModelRegistryEntry } from './agent-model-registry';
import { AGENT_MODEL_KEYS } from '@clawville/shared';

/**
 * Regression (F5, 2026-06-21): a user picked a chibi at /create-agent but loaded
 * as the default Milady. Root cause: the chibi keys (`eliza_chibi`,
 * `milady_chibi`) existed in this WEB registry (so the picker offered them) but
 * were MISSING from the shared AGENT_MODELS — so the create flow's
 * `AGENT_MODEL_KEYS.includes(modelKey)` check dropped them to `undefined` and the
 * server applied DEFAULT_AGENT_MODEL_KEY (a Milady), silently.
 *
 * Prevention: the web MODEL_REGISTRY and the shared AGENT_MODELS must never drift.
 * Every web key MUST be a valid shared key, or a pick of that key is silently
 * substituted at signup.
 */
describe('web MODEL_REGISTRY ↔ shared AGENT_MODEL_KEYS parity (F5)', () => {
  it('every PICKABLE web model key is registered in shared AGENT_MODEL_KEYS', () => {
    const shared = new Set(AGENT_MODEL_KEYS as readonly string[]);
    // pickerHidden keys (reserved Hatcher avatars, the `adinero` NPC species) are
    // server-assigned only — never offered at /create-agent — so they need not be
    // in the shared enum and cannot be silently dropped at signup. The invariant
    // that prevents the chibi bug is: every key the PICKER can offer must be a
    // valid shared key.
    const missing = (Object.entries(MODEL_REGISTRY) as [string, ModelRegistryEntry][])
      .filter(([, e]) => !e.pickerHidden)
      .map(([k]) => k)
      .filter((k) => !shared.has(k));
    expect(missing).toEqual([]);
  });

  it('chibi avatars are selectable end-to-end', () => {
    const shared = AGENT_MODEL_KEYS as readonly string[];
    expect(shared).toContain('eliza_chibi');
    expect(shared).toContain('milady_chibi');
  });
});
