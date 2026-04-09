// ---------------------------------------------------------------------------
// Quest Board types — shared between API and frontend
// ---------------------------------------------------------------------------

export type QuestTier = 'side_quest' | 'main_quest' | 'legendary';
export type QuestStatus = 'draft' | 'active' | 'completed' | 'archived';
export type QuestSubmissionStatus =
  | 'accepted'
  | 'in_progress'
  | 'submitted'
  | 'in_review'
  | 'approved'
  | 'rejected';

export interface Quest {
  id: string;
  title: string;
  description: string;
  tier: QuestTier;
  status: QuestStatus;
  tokenReward: number;
  skillRewardId: string | null;
  skillReward?: { id: string; name: string; description: string; rarity: string } | null;
  titleReward: string | null;
  maxCompletions: number | null;
  currentCompletions: number | null;
  requirements: string | null;
  verificationMethod: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface QuestSubmission {
  id: string;
  questId: string;
  status: QuestSubmissionStatus;
  prLink: string | null;
  submissionNote: string | null;
  reviewNote: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  quest: {
    title: string;
    description: string;
    tier: QuestTier;
    tokenReward: number;
    skillRewardId: string | null;
    titleReward: string | null;
    status: QuestStatus;
  };
}

export interface QuestReward {
  id: string;
  questId: string;
  submissionId: string;
  tokensAwarded: number;
  skillId: string | null;
  skillName: string | null;
  titleAwarded: string | null;
  claimedAt: string;
  quest: {
    title: string;
    tier: QuestTier;
    description: string;
  };
}

export interface QuestSeed {
  title: string;
  description: string;
  tier: QuestTier;
  tokenReward: number;
  titleReward?: string;
  maxCompletions?: number;
  requirements: string;
  verificationMethod: 'pr_review' | 'manual';
}
