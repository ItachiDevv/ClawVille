import { describe, expect, it } from 'bun:test';
import {
  protocolKnowledgeEntityId,
  protocolKnowledgeMemoryId,
  protocolKnowledgeRoomId,
  splitProtocolManualSections,
} from './protocol-knowledge';

const AGENT_A = '10000000-0000-0000-0000-000000000001';
const AGENT_B = '20000000-0000-0000-0000-000000000002';

describe('protocol knowledge ID scoping', () => {
  it('derives fully disjoint memory and entity IDs for different agents', () => {
    const idsFor = (agentId: string) => new Set([
      protocolKnowledgeRoomId(agentId),
      protocolKnowledgeEntityId(agentId),
      protocolKnowledgeMemoryId(agentId, 20, 0),
      protocolKnowledgeMemoryId(agentId, 20, 1),
    ]);

    const a = idsFor(AGENT_A);
    const b = idsFor(AGENT_B);
    expect([...a].filter((id) => b.has(id))).toEqual([]);
  });

  it('is stable and idempotent for the same agent, version, and section', () => {
    expect(protocolKnowledgeEntityId(AGENT_A)).toBe(
      protocolKnowledgeEntityId(AGENT_A),
    );
    expect(protocolKnowledgeMemoryId(AGENT_A, 20, 3)).toBe(
      protocolKnowledgeMemoryId(AGENT_A, 20, 3),
    );
  });

  it('preserves the existing markdown section granularity after extraction', () => {
    expect(
      splitProtocolManualSections('# Manual\nIntro\n## One\nBody\n### Detail\nMore\n## Two\nEnd'),
    ).toEqual([
      '# Manual\nIntro',
      '## One\nBody\n### Detail\nMore',
      '## Two\nEnd',
    ]);
  });
});
