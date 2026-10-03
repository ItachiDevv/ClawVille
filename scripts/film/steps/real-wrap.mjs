// Wraps a rehearsal step with the real-shoot pre-roll and post-roll (1.5 s each).
// Usage in SHOOT.md: REAL_STEP=s2-spawn.mjs node scripts/film/film-rig.mjs take real-s2 10 scripts/film/steps/real-wrap.mjs
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRE_ROLL_MS = 1500;
export const POST_ROLL_MS = 1500;

export default async (h) => {
  const name = process.env.REAL_STEP;
  if (!name) throw new Error('set REAL_STEP=<step file in this folder>');
  const mod = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), name)).href);
  h.log(`pre-roll ${PRE_ROLL_MS} ms, then ${name}`);
  await h.sleep(PRE_ROLL_MS);
  await mod.default(h);
  h.log(`post-roll ${POST_ROLL_MS} ms`);
  await h.sleep(POST_ROLL_MS);
};
