import { expect, test } from 'bun:test';
import { BRAINCHAIN_OFFICE_KNOWLEDGE, buildBrainchainOfficeManual } from '@clawville/shared';
import { brainchainOffice, SYSTEM_AGENT_TEMPLATES, townGuide } from '@clawville/agent-templates';
import { PROTOCOL_TOPICS, buildProtocolManual, buildProtocolTopic } from '../skill-protocol';

test('BrainChain curriculum reaches the full hosted manual and the bound-agent topic', () => {
  const apiBase = 'https://api.example.test';
  const curriculum = buildBrainchainOfficeManual();
  const topic = buildProtocolTopic(apiBase, 'brainchain');
  expect(PROTOCOL_TOPICS.some((entry) => entry.id === 'brainchain')).toBe(true);
  expect(topic).toContain(curriculum);
  expect(buildProtocolManual(apiBase)).toContain(curriculum);
  expect(topic).toContain(`${apiBase}/api/chat/system/brainchain-office`);
  expect(topic).toContain('X-Clawville-Agent-Session');
  expect(SYSTEM_AGENT_TEMPLATES['brainchain-office']).toBe(brainchainOffice);
  expect(townGuide.knowledge.join('\n')).toContain('BrainChain Office Guide');
});

test('Office teacher consumes every canonical curriculum section', () => {
  for (const section of BRAINCHAIN_OFFICE_KNOWLEDGE) {
    expect(brainchainOffice.knowledge).toContain(section);
  }
  expect(brainchainOffice.knowledge.join('\n')).toContain('curriculum version');
  expect(brainchainOffice.style.all.join('\n')).toContain('Never ask for a private key');
});
