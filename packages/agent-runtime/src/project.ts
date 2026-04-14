/**
 * ClawVille ElizaOS Project
 *
 * Standard ElizaOS Project export — can be used with:
 *   elizaos start --project @clawville/agent-runtime
 *
 * Defines all 10 location agents + 1 default pet agent as ProjectAgent entries.
 * Each agent gets the ClawVille game plugin (actions + providers) and
 * Gemini text/embedding providers.
 */

import type { Project, ProjectAgent, Plugin } from '@elizaos/core';
import {
  CHARACTERS,
  defaultPetCharacter,
} from './characters';
import { clawvillePlugin } from './plugins/clawville-plugin';

// Cast to ElizaOS Plugin — our custom Action type is structurally compatible
// but uses a slightly different examples format (user vs name field).
const gamePlugin = clawvillePlugin as unknown as Plugin;

// ---------------------------------------------------------------------------
// Location agents — one per building, each with its own Character
// ---------------------------------------------------------------------------

const locationAgents: ProjectAgent[] = Object.entries(CHARACTERS).map(
  ([locationId, character]) => ({
    character,
    init: async (runtime) => {
      console.log(`[ClawVille] Location agent "${character.name}" (${locationId}) initialized`);
    },
    plugins: [gamePlugin],
  }),
);

// ---------------------------------------------------------------------------
// Default pet agent — used when a user creates a new agent without customization
// ---------------------------------------------------------------------------

const petAgent: ProjectAgent = {
  character: defaultPetCharacter,
  init: async (runtime) => {
    console.log(`[ClawVille] Default pet agent initialized`);
  },
  plugins: [gamePlugin],
};

// ---------------------------------------------------------------------------
// Project export
// ---------------------------------------------------------------------------

const project: Project = {
  agents: [...locationAgents, petAgent],
};

export default project;
export { project };
