import { db } from '@clawville/database';
import { json, error } from '@/lib/api-utils';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const locations = await db.query.mapLocations.findMany();
    return json({ locations });
  } catch (err) {
    console.error('Get locations error:', err);
    return error('Internal server error', 500);
  }
}
