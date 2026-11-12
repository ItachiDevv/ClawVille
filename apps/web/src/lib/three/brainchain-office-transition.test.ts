import { useNpcStore, PLAYER_NPC_ID } from '@/stores/npc';
import { beforeEach, describe, expect, test } from 'bun:test';
import { useGameStore } from '@/stores/game';
import { useActivityStore } from '@/stores/activity';
import { useTransitionStore } from '@/components/transitions/SceneTransition';
import { canWalkIntoBrainchainOffice, placeAtBrainchainOfficeExit } from './brainchain-office-transition';
import { OFFICE_EXIT_WORLD, isInsideOfficeVortex } from './brainchain-office-door';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { avatarPositionRef } from '@/stores/game';
const initial = useGameStore.getState();
describe('BrainChain local door guards', () => {
  beforeEach(() => { useGameStore.setState({ ...initial, controlMode: 'player' });
    useActivityStore.setState({ roomId: null }); useTransitionStore.setState({ active: false }); });
  test('only local player and NPC control can cross', () => {
    expect(canWalkIntoBrainchainOffice()).toBe(true);
    useGameStore.setState({ controlMode: 'npc' }); expect(canWalkIntoBrainchainOffice()).toBe(true);
    useGameStore.setState({ controlMode: 'explore' }); expect(canWalkIntoBrainchainOffice()).toBe(false);
    useGameStore.setState({ controlMode: 'autonomous' }); expect(canWalkIntoBrainchainOffice()).toBe(false);
  });
  test('frozen movement, portals, activities and independent modals block entry', () => {
    for (const field of ['movementFrozen', 'settingsModalOpen', 'walletLinkModalOpen', 'inventoryOpen',
      'shopOpen', 'menuOpen', 'cosmeticDrawerOpen', 'locationConfigModalOpen', 'agentConnectModalOpen',
      'skillBuilderOpen', 'landOfficeOpen', 'worldMapOpen', 'questBoardOpen', 'bountyBoardOpen',
      'exchangeOpen', 'tradingFloorOpen', 'leaderboardOpen', 'arenaSettingsOpen'] as const) {
      useGameStore.setState({ [field]: true }); expect(canWalkIntoBrainchainOffice()).toBe(false);
      useGameStore.setState({ [field]: false });
    }
    useGameStore.setState({ currentPortalBuildingId: 'api-integrations' }); expect(canWalkIntoBrainchainOffice()).toBe(false);
    useGameStore.setState({ currentPortalBuildingId: null }); useActivityStore.setState({ roomId: 'test-room' });
    expect(canWalkIntoBrainchainOffice()).toBe(false);
  });
  test('return placement also updates the actual possessed local body', () => {
    const saved = useNpcStore.getState().npcs;
    try {
      useNpcStore.getState().spawnPlayerNpc();
      const npc = { ...useNpcStore.getState().npcs.find(n => n.id === PLAYER_NPC_ID)!, id: 'local-possessed-test' };
      useNpcStore.setState({ npcs: [npc] });
      useGameStore.setState({ controlMode: 'npc', possessedNpcId: npc.id });
      placeAtBrainchainOfficeExit();
      expect(npc.x).toBe(avatarPositionRef.x); expect(npc.prevX).toBe(npc.x);
      expect(npc.y).toBe(avatarPositionRef.y); expect(npc.prevY).toBe(npc.y);
      expect(npc.facingAngle).toBe(-2.093);
    } finally { useNpcStore.setState({ npcs: saved }); }
  });
  test('return placement updates the live and store position outside the trigger', () => {
    placeAtBrainchainOfficeExit();
    expect(avatarPositionRef.x).toBe(MAP_WIDTH / 2 + OFFICE_EXIT_WORLD.x);
    expect(avatarPositionRef.y).toBe(MAP_HEIGHT / 2 + OFFICE_EXIT_WORLD.z);
    expect(useGameStore.getState().avatarPosition).toEqual({ x: avatarPositionRef.x, y: avatarPositionRef.y });
    expect(isInsideOfficeVortex(OFFICE_EXIT_WORLD.x, OFFICE_EXIT_WORLD.z)).toBe(false);
  });
});
