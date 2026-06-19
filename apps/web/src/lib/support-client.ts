/**
 * Support ticket submission (lean). Cookie-auth: a logged-in user or a guest is
 * resolved server-side from the session/fingerprint, so the browser just sends
 * `credentials: 'include'`. (Connected agents file via their own client, not
 * this web UI.) Server: POST /api/support/tickets (`apps/api/src/routes/support.ts`).
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export const SUPPORT_CATEGORIES = ['bug', 'payment', 'fairness', 'account', 'gameplay', 'other'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export interface SupportTicketContext {
  page?: string;
  url?: string;
  game?: string;
  eventId?: string;
  userAgent?: string;
}

export interface SupportTicketInput {
  category: SupportCategory;
  subject?: string;
  message: string;
  context?: SupportTicketContext;
}

export async function submitSupportTicket(
  input: SupportTicketInput,
): Promise<{ ticketId: string; status: string }> {
  const res = await fetch(`${API_BASE}/api/support/tickets`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string; error?: string };
      msg = b.message || b.error || msg;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as { ticketId: string; status: string };
}
