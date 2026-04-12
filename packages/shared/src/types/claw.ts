import type { AvatarSpecies, AvatarColor } from './avatar';

export interface ClawPersonalityJson {
  tone?: string;
  interests?: string[];
  greeting?: string;
}

export interface ClawResearchConfig {
  themes?: Record<string, { label: string; focus: string }>;
  globalFocus?: string;
  articleSources?: string[];
}

export interface ClawConfig {
  id?: string;
  name: string;
  species: AvatarSpecies;
  color: AvatarColor;
  personality?: ClawPersonalityJson;
  researchConfig?: ClawResearchConfig;
  knowledge?: string[];
}

export interface ClawSessionState {
  clawId: string;
  config: ClawConfig;
  connectedAt: number;
  positionX: number;
  positionY: number;
  activity: string;
  activityEmoji: string;
}

export interface BrowserClawSnapshot {
  sessionId: string;
  name: string;
  species: string;
  color: string;
  x: number;
  y: number;
  direction: string;
  activity: string;
  activityEmoji: string;
}
