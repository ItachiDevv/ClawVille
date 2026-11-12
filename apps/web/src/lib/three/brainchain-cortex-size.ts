export const CORTEX_MODEL = '/models/brainchain/brainchain-clerk-v1-ktx.glb';
/** Staging baseline: 106 scale = 182 wu Idle; 106 * 230 / 182 = 133.96. */
export const CORTEX_SCALE = 134;
/** Bind-pose box at 134 is about 254 wu. Idle height target is about 230 wu. */
export const CORTEX_MAX_HEIGHT = 260;
export function npcRenderedHeightLimit(model: string, requested?: number): number {
  return model === CORTEX_MODEL && requested === CORTEX_MAX_HEIGHT ? CORTEX_MAX_HEIGHT : 201;
}
