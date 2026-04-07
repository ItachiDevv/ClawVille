export interface ResearchArticleSeed {
  url: string;
  title: string;
  source: string;
}

export type ResearchPhase =
  | 'idle'
  | 'fetching_articles'
  | 'reading'
  | 'synthesizing'
  | 'creating_skill'
  | 'complete'
  | 'error';

export interface ResearchThoughtEvent {
  type: 'research_thought';
  sessionId: string;
  petId: string;
  locationId: string;
  phase: ResearchPhase;
  message: string;
  timestamp: string;
  progress?: number;
  articleIndex?: number;
  articleCount?: number;
  synthesizedKnowledge?: string[];
  skillMd?: string;
}
