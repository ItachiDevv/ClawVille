export interface KnowledgeMergeResult {
  currentKnowledge: string[];
  newKnowledge: string[];
  mergedKnowledge: string[];
}

export function knowledgeEntriesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Merge knowledge without disturbing any sibling character/persona fields. */
export function mergeKnowledgeEntries(
  currentValue: unknown,
  additions: readonly string[],
): KnowledgeMergeResult {
  const currentKnowledge = knowledgeEntriesFrom(currentValue);
  const known = new Set(currentKnowledge);
  const newKnowledge: string[] = [];

  for (const entry of additions) {
    if (known.has(entry)) continue;
    known.add(entry);
    newKnowledge.push(entry);
  }

  return {
    currentKnowledge,
    newKnowledge,
    mergedKnowledge: [...currentKnowledge, ...newKnowledge],
  };
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function mergeKnowledgeCustomization(
  customization: unknown,
  mergedKnowledge: readonly string[],
): Record<string, unknown> {
  return {
    ...recordValue(customization),
    knowledge: [...mergedKnowledge],
  };
}
