import { json, requireAuth } from '@/lib/api-utils';

export async function GET() {
  const { error, user } = await requireAuth();
  if (error) return error;

  return json({ user });
}
