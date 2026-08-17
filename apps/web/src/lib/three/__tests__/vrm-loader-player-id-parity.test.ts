import { describe, expect, it } from 'bun:test';
import { PLAYER_NPC_ID } from '@/stores/npc';
import { PLAYER_NPC_INSTANCE_ID } from '@/lib/three/vrm-loader';

// Rung-4 slice C (Codex round-2 finding 5): vrm-loader duplicates the
// possessed-body id as a literal instead of importing the zustand store
// (chunk-weight + cycle risk). This parity test is the drift guard — if it
// fails, the possessed demo body silently loses both its parse-queue
// priority lane and its player-class telemetry split.
describe('vrm-loader player-npc instance id parity', () => {
  it('matches stores/npc PLAYER_NPC_ID exactly', () => {
    expect(PLAYER_NPC_INSTANCE_ID).toBe(PLAYER_NPC_ID);
  });
});
