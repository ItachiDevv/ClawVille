import { NextRequest } from 'next/server';
import { db, avatars, eq } from '@clawville/database';
import { json } from '@/lib/api-utils';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  if (!name || name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9]+$/.test(name)) {
    return json({ available: false, reason: 'Name must be 3-20 alphanumeric characters' });
  }

  const existing = await db.query.avatars.findFirst({
    where: eq(avatars.name, name),
  });

  return json({ available: !existing });
}
