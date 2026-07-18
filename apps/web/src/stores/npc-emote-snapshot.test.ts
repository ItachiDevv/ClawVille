import { beforeEach, describe, expect, it } from 'bun:test';
import { useNpcStore } from './npc';

const BASE_NPC = {
  id: 'agent-emote-body',
  name: 'Agent Emote Body',
  x: 11_264,
  y: 11_264,
  direction: 'idle' as const,
  species: 'milady_official_1',
  color: 0xffffff,
  hp: 100,
  maxHp: 100,
  isDead: false,
  hasSword: false,
  inCombat: false,
  inConversation: false,
  inventory: [],
  isOpenClaw: true,
};

function snapshot(emoteClip: string, emoteSeq: number) {
  return {
    npcs: [{ ...BASE_NPC, emoteClip, emoteSeq }],
    conversations: [],
    combats: [],
    autonomousAvatars: [],
    timestamp: Date.now(),
  };
}

beforeEach(() => {
  useNpcStore.setState({
    npcs: [],
    chatBubbles: [],
    combatEvents: [],
    lootEvents: [],
    combatLog: [],
  });
});

describe('NPC emote snapshot transport', () => {
  it('preserves clip/sequence through the identity-stable store mutation path', () => {
    const store = useNpcStore.getState();
    store.updateFromSnapshot(snapshot('clap', 1));
    const first = useNpcStore.getState().npcs[0];

    store.updateFromSnapshot(snapshot('breakdance', 2));
    const second = useNpcStore.getState().npcs[0];

    expect(second).toBe(first);
    expect(second.emoteClip).toBe('breakdance');
    expect(second.emoteSeq).toBe(2);
  });

  it('guards the frame edge against omitted optional sequences', async () => {
    const source = await Bun.file(
      new URL('../lib/three/arena-npcs.tsx', import.meta.url),
    ).text();
    expect(source).toContain(
      'serverEmoteSeq !== undefined &&\n        serverEmoteSeq !== serverEmoteSeqRef.current',
    );
    expect(source).toContain('!d.isOpenClaw &&');
    expect(source).not.toContain('!serverOneShotOwnedRef.current');
  });
});
