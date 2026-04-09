// ---------------------------------------------------------------------------
// Bounty Board types — shared between API and frontend
// ---------------------------------------------------------------------------

export type BountyDifficulty = 'beginner' | 'intermediate' | 'advanced' | 'expert';
export type BountyStatus = 'open' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
export type BountyAttemptStatus =
  | 'claimed'
  | 'in_progress'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'abandoned';
export type ReputationTier = 'newcomer' | 'apprentice' | 'journeyman' | 'expert' | 'master';

export interface Bounty {
  id: string;
  creatorId: string;
  creatorAvatarName: string;
  creatorSpecies: string;
  title: string;
  description: string;
  requirements?: string | null;
  difficulty: BountyDifficulty;
  status: BountyStatus;
  tokenReward: number;
  maxAttempts: number;
  currentAttempts: number;
  isFeatured: boolean;
  tags: string[] | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface BountyAttempt {
  id: string;
  bountyId: string;
  hunterId: string;
  status: BountyAttemptStatus;
  prLink: string | null;
  submissionNote: string | null;
  reviewNote: string | null;
  claimedAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  bounty: {
    title: string;
    description: string;
    difficulty: BountyDifficulty;
    tokenReward: number;
    status: BountyStatus;
  };
}

export interface BountyAttemptForCreator {
  id: string;
  hunterId: string;
  hunterName: string;
  status: BountyAttemptStatus;
  prLink: string | null;
  submissionNote: string | null;
  reviewNote: string | null;
  claimedAt: string;
  submittedAt: string | null;
}

export interface BountyWithAttempts extends Omit<Bounty, 'creatorAvatarName' | 'creatorSpecies'> {
  completedAt: string | null;
  updatedAt: string;
  attempts: BountyAttemptForCreator[];
}

export interface BountyReputation {
  avatarId: string;
  tier: ReputationTier;
  totalCompleted: number;
  totalAttempted: number;
  totalEarned: number;
  totalPosted: number;
  successRate: number;
}
