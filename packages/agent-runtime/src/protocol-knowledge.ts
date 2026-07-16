import type { UUID } from '@elizaos/core';
import { v5 as uuidv5 } from 'uuid';

/** Stable namespace shared by the hosted-agent room and knowledge ID scheme. */
export const ROOM_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export const PROTOCOL_KNOWLEDGE_KEY = 'protocol-knowledge';

/** Deterministic room ID scoped to one runtime agent and one logical user/key. */
export function generateRoomId(agentId: string, userId: string): UUID {
  return uuidv5(`${agentId}-${userId}`, ROOM_NAMESPACE) as UUID;
}

/** The isolated protocol-manual room for one hosted platform agent. */
export function protocolKnowledgeRoomId(agentId: string): UUID {
  return generateRoomId(agentId, PROTOCOL_KNOWLEDGE_KEY);
}

/** The isolated protocol-manual entity for one hosted platform agent. */
export function protocolKnowledgeEntityId(agentId: string): UUID {
  return uuidv5(`${agentId}:${PROTOCOL_KNOWLEDGE_KEY}`, ROOM_NAMESPACE) as UUID;
}

/** Stable, agent-scoped ID for one versioned protocol-manual section. */
export function protocolKnowledgeMemoryId(
  agentId: string,
  version: number,
  section: number,
): UUID {
  return uuidv5(
    `${PROTOCOL_KNOWLEDGE_KEY}:${agentId}:v${version}:${section}`,
    ROOM_NAMESPACE,
  ) as UUID;
}

/**
 * Split markdown into `## `-heading sections. Content before the first `## `
 * heading becomes its own leading chunk; deeper headings stay with their
 * parent section. Pure + total, returning [] only for empty input.
 */
export function splitProtocolManualSections(manual: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const joined = current.join('\n').trim();
    if (joined) sections.push(joined);
  };
  for (const line of manual.split('\n')) {
    if (line.startsWith('## ')) {
      flush();
      current = [line];
    } else {
      current.push(line);
    }
  }
  flush();
  return sections;
}
