/**
 * ClawVille ElizaOS Project
 *
 * Standard ElizaOS Project export — can be used with:
 *   elizaos start --project @clawville/agent-runtime
 *
 * Defines all 10 location agents + 1 default avatar agent as ProjectAgent entries.
 * Each agent gets the ClawVille game plugin (actions + providers) plus the
 * OpenAI text (gpt-4o-mini/gpt-4o) + embedding (text-embedding-3-small,
 * 1536-dim) providers. Without these wired here, an agent booted via
 * `elizaos start --project @clawville/agent-runtime` would have NO text or
 * embedding model provider.
 */

import type { Project, ProjectAgent, Plugin } from '@elizaos/core';
import {
  CHARACTERS,
  defaultAvatarCharacter,
} from './characters';
import { clawvillePlugin } from './plugins/clawville-plugin';
import { createOpenAITextPlugin } from './plugins/openai-text-provider';
import { createOpenAIEmbeddingPlugin } from './plugins/openai-embedding-provider';

// Cast to ElizaOS Plugin — our custom Action type is structurally compatible
// but uses a slightly different examples format (user vs name field).
const gamePlugin = clawvillePlugin as unknown as Plugin;

// OpenAI providers — supply TEXT_SMALL/TEXT_LARGE + TEXT_EMBEDDING (1536-dim)
// to every project agent. apiKey falls back to process.env.OPENAI_API_KEY
// inside each plugin, but we pass it explicitly for clarity.
const openaiTextPlugin = createOpenAITextPlugin({
  apiKey: process.env.OPENAI_API_KEY,
});
const openaiEmbeddingPlugin = createOpenAIEmbeddingPlugin({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------------------------------------
// Location agents — one per building, each with its own Character
// ---------------------------------------------------------------------------

const locationAgents: ProjectAgent[] = Object.entries(CHARACTERS).map(
  ([locationId, character]) => ({
    character,
    init: async (runtime) => {
      console.log(`[ClawVille] Location agent "${character.name}" (${locationId}) initialized`);
    },
    plugins: [gamePlugin, openaiTextPlugin, openaiEmbeddingPlugin],
  }),
);

// ---------------------------------------------------------------------------
// Default avatar agent — used when a user creates a new agent without customization
// ---------------------------------------------------------------------------

const avatarAgent: ProjectAgent = {
  character: defaultAvatarCharacter,
  init: async (runtime) => {
    console.log(`[ClawVille] Default avatar agent initialized`);
  },
  plugins: [gamePlugin, openaiTextPlugin, openaiEmbeddingPlugin],
};

// ---------------------------------------------------------------------------
// Project export
// ---------------------------------------------------------------------------

const project: Project = {
  agents: [...locationAgents, avatarAgent],
};

export default project;
export { project };
