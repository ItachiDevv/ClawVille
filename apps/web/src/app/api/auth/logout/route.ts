import { json, requireAuth, clearSessionCookie } from '@/lib/api-utils';
import { lucia } from '@/lib/auth';

export async function POST() {
  const { error, session } = await requireAuth();
  if (error) return error;

  await lucia.invalidateSession(session.id);
  await clearSessionCookie();

  return json({ success: true });
}
