export type AgentStatus = 'pending' | 'starting' | 'running' | 'paused' | 'error' | 'stopped';

export interface PlatformAgent {
  id: string;
  userId: string;
  name: string;
  type: 'location-agent';
  status: AgentStatus;
  customization: Record<string, unknown> | null;
  config: Record<string, unknown>;
  lastHeartbeat: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}
