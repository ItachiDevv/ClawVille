import { buildingSkills, db, sql } from '@clawville/database';
import { BRAINCHAIN_CURRICULUM_VERSION, BRAINCHAIN_OFFICE_ID, buildBrainchainOfficeManual } from '@clawville/shared';
import { proofHash } from './binding-proof';
import type { ActivityIdentity } from '../../middleware/require-auth-or-agent';

export class BrainChainCurriculumError extends Error { readonly code = 'runtime_unavailable'; }

/** Refuse both older versions and conflicting content at the same version during rolling deployments. */
export async function seedBrainChainCurriculum() {
  const content = buildBrainchainOfficeManual();
  const contentHash = proofHash(content);
  const source = { name: BRAINCHAIN_OFFICE_ID, description: 'Reviewed BrainChain tasks, worker requirements, and recovery boundaries.',
    content, contentHash, generatorVersion: BRAINCHAIN_CURRICULUM_VERSION, updatedAt: new Date() };
  const seeded = await db.insert(buildingSkills).values({ buildingId: BRAINCHAIN_OFFICE_ID, ...source })
    .onConflictDoUpdate({ target: buildingSkills.buildingId, set: source,
      setWhere: sql`${buildingSkills.generatorVersion} < ${BRAINCHAIN_CURRICULUM_VERSION} OR
        (${buildingSkills.generatorVersion} = ${BRAINCHAIN_CURRICULUM_VERSION} AND ${buildingSkills.contentHash} = ${contentHash})`,
    }).returning({ id: buildingSkills.id });
  if (seeded.length !== 1) throw new BrainChainCurriculumError('Curriculum version conflicts with the deployed source');
}

/** Canonical source is tracked code. Installation reuses the existing agent-scoped persistence and locks. */
export async function installBrainChainCurriculum(identity: ActivityIdentity) {
  await seedBrainChainCurriculum();
  const { installBuildingSkillIntoAgent } = await import('../building-skill-install');
  const result = await installBuildingSkillIntoAgent({ userId: identity.userId, avatarId: identity.avatarId,
    buildingId: BRAINCHAIN_OFFICE_ID, requireComplete: true,
    ...(identity.kind === 'agent' ? { provenAgentId: identity.agentId } : {}) });
  if (result.contentHash !== `sha256:${proofHash(buildBrainchainOfficeManual())}`) {
    throw new BrainChainCurriculumError('Curriculum changed during installation; refresh against the current deployment');
  }
  return { ...result, version: BRAINCHAIN_CURRICULUM_VERSION,
    manualUrl: '/api/brainchain/knowledge',
    consumptionVerified: false,
    note: result.installed === 'marker' ? 'Association saved. The connected agent must fetch and consume the manual.' : 'Knowledge stored. Runtime consumption requires separate verification.',
  };
}
