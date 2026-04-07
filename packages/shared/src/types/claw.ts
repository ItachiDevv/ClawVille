import type { PetSpecies, PetColor } from './pet';

export interface ClawPersonalityJson {
  tone?: string;
  interests?: string[];
  greeting?: string;
}

export interface ClawResearchConfig {
  themes: Record<string, { label: string; focus: string }>;
  globalFocus?: string;
  articleSources?: string[];
}

export interface ClawConfig {
  id?: string;
  name: string;
  species: PetSpecies;
  color: PetColor;
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
