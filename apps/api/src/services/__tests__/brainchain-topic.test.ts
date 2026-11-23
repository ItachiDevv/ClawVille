import { expect, test } from 'bun:test';
import { BRAINCHAIN_OFFICE_KNOWLEDGE, buildBrainchainOfficeManual } from '@clawville/shared';
import { apiIntegrations, LOCATION_TEMPLATES, SYSTEM_AGENT_TEMPLATES, townGuide } from '@clawville/agent-templates';
import { PROTOCOL_TOPICS, buildProtocolManual, buildProtocolTopic } from '../skill-protocol';

test('BrainChain curriculum reaches the full hosted manual and the bound-agent topic', () => {
  const apiBase = 'https://api.example.test';
  const curriculum = buildBrainchainOfficeManual();
  const topic = buildProtocolTopic(apiBase, 'brainchain');
  expect(PROTOCOL_TOPICS.some((entry) => entry.id === 'brainchain')).toBe(true);
  expect(topic).toContain(curriculum);
  expect(buildProtocolManual(apiBase)).toContain(curriculum);
  expect(topic).toContain(`${apiBase}/api/chat/system/brainchain-office`);
  expect(topic).toContain(`${apiBase}/api/agent/:sessionId/building/api-integrations/chat`);
  expect(topic).toContain('enter_building(buildingId=api-integrations)');
  expect(topic).toContain('X-Clawville-Agent-Session');
  // 2026-11-10: Cortex at the api-integrations building replaced the Office Guide.
  expect(LOCATION_TEMPLATES['api-integrations']).toBe(apiIntegrations);
  expect(SYSTEM_AGENT_TEMPLATES['brainchain-office']).toBe(apiIntegrations);
  expect(apiIntegrations.name).toBe('Cortex');
  expect(topic).toContain('exit --to-solana <address>');
  expect(topic).toContain('ClawVille does not draft mainnet Solana purchases.');
  const nori = townGuide.knowledge.join('\n');
  expect(nori).toContain('Cortex');
  expect(nori).toContain('on mainnet a worker cashes out to Solana with the worker CLI');
  expect(nori).toContain('api-integrations');
  expect(nori).not.toContain('Office Guide');
});

test('Office teacher consumes every canonical curriculum section and keeps the API lesson', () => {
  for (const section of BRAINCHAIN_OFFICE_KNOWLEDGE) {
    expect(apiIntegrations.knowledge).toContain(section);
  }
  expect(apiIntegrations.bio[0]).toStartWith('I teach agents how to earn on BrainChain.');
  expect(apiIntegrations.topics[0]).toBe('earning on BrainChain');
  expect(apiIntegrations.messageExamples[0]?.[0]?.content.text).toBe('How does my agent earn on BrainChain?');
  expect(apiIntegrations.knowledge[1]).toBe(BRAINCHAIN_OFFICE_KNOWLEDGE[0]);
  const knowledge = apiIntegrations.knowledge.join('\n');
  expect(knowledge).toContain('curriculum version');
  expect(knowledge).toContain('HMAC-SHA256');
  expect(knowledge).toContain('exponential backoff');
  expect(apiIntegrations.style.all.join('\n')).toContain('Never ask for a private key');
});
