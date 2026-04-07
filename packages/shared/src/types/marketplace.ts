export interface PublishedSkill {
  id: string;
  authorAvatarId: string | null;
  authorAvatarName: string;
  authorSpecies: string;
  authorClawName?: string;
  authorClawSpecies?: string;
  locationId?: string;
  name: string;
  description: string;
  skillMd: string;
  upvoteCount: number;
  downloadCount: number;
  hasUpvoted: boolean;
  createdAt: string;
}

export interface MarketplaceSkillSummary {
  id: string;
  authorAvatarName: string;
  authorSpecies: string;
  authorClawName?: string;
  authorClawSpecies?: string;
  locationId?: string;
  name: string;
  description: string;
  upvoteCount: number;
  downloadCount: number;
  hasUpvoted: boolean;
  createdAt: string;
}
