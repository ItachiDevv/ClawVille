import { describe, expect, test } from 'bun:test';
import { installBuildingSkillIntoAgent, type BuildingSkillInstallDependencies } from '../building-skill-install';

const input = { userId: 'user', avatarId: 'avatar', buildingId: 'brainchain-office', requireComplete: true };
function fixture(silent: boolean) {
  const persisted = new Set<number>();
  const loadSkill = async () => ({ content: '# Office\nIntroduction\n\n## Work\nDetails', contentHash: `sha256:${'a'.repeat(64)}` });
  const installedSections = async () => new Set(persisted);
  const dependencies: BuildingSkillInstallDependencies = {
    loadSkill, installedSections, resolvePlatformAgentId: async () => 'platform-agent',
    getRuntime: async () => ({ getElizaRuntime: () => ({ createMemory: async (memory: { metadata: { section: number } }) => {
      if (!silent) persisted.add(memory.metadata.section);
    } }) }),
    embed: async () => [0, 1], mergeConnectedMarkers: async () => true,
    withLocalInstallLock: async (_key, run) => run(),
    withCrossPodInstallLock: async (_key, run) => run({ loadSkill, installedSections, retireStaleSections: async () => true }),
    withGlobalInstallSlot: async (run) => run(),
  };
  return { persisted, dependencies };
}
describe('Office hosted install persistence gate', () => {
  test('silent writer success cannot report a complete hosted install', async () => {
    const { dependencies } = fixture(true);
    await expect(installBuildingSkillIntoAgent(input, dependencies)).rejects.toThrow('persistence is incomplete');
  });
  test('complete readback returns runtime and repeat returns already', async () => {
    const { dependencies, persisted } = fixture(false);
    expect((await installBuildingSkillIntoAgent(input, dependencies)).installed).toBe('runtime');
    expect(persisted.size).toBe(2);
    expect((await installBuildingSkillIntoAgent(input, dependencies)).installed).toBe('already');
  });
  test('partial persisted sections remain recoverable without false success', async () => {
    const { dependencies, persisted } = fixture(true);
    persisted.add(0);
    await expect(installBuildingSkillIntoAgent(input, dependencies)).rejects.toThrow('persistence is incomplete');
    expect(persisted.size).toBe(1);
  });
});
