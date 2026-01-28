export interface MapLocation {
  id: string;
  name: string;
  description: string;
  icon: string;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
}

export interface LocationAgent {
  id: string;
  userId: string;
  locationId: string;
  agentName: string;
  characterConfig: LocationCharacterConfig;
  platformAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationCharacterConfig {
  name: string;
  personality: string;
  bio: string;
  greeting: string;
  tone: 'formal' | 'casual' | 'friendly' | 'professional';
  topics: string[];
  rules: string[];
  style: string[];
}
