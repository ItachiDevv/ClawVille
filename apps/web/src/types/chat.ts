/**
 * Shared chat message shape used by both the teacher (location) chat and
 * the town-guide (system-agent) chat. Keeping one canonical type means
 * both `use-location-chat` and `use-guide-chat` produce the same shape so
 * a future lift into the parent `<ChatPanel />` doesn't need a conversion.
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}
