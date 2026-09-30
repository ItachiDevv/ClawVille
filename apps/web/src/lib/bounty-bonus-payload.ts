/** One bonus row as the Bounty Board Create form holds it. */
export interface BonusRewardFormRow {
  type: string;
  label: string;
  value: string;
}

/**
 * Map one Create-form bonus row to the server contract (`bonusRewardSchema` in
 * `apps/api/src/routes/bounties.ts`): `rewardType` plus the typed field. The form
 * used to send `{ type, label, value }`, which the server rejects (400), so no
 * bounty with a bonus could be posted. A knowledge_book row's value is the book
 * id; the server requires a real shop book id and moves one copy from the poster
 * to the winner on approval (security M11, 2026-09-30).
 */
export function toBonusRewardPayload(bonus: BonusRewardFormRow) {
  const label = bonus.label.trim();
  const value = bonus.value.trim();
  if (bonus.type === 'knowledge_book') return { rewardType: 'knowledge_book' as const, bookId: value };
  if (bonus.type === 'agent_config') return { rewardType: 'agent_config' as const, agentConfigId: value };
  return {
    rewardType: 'custom' as const,
    customDescription: [label, value].filter(Boolean).join(': ').slice(0, 500),
  };
}
