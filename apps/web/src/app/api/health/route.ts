import { json } from '@/lib/api-utils';

export async function GET() {
  return json({ status: 'ok', timestamp: new Date().toISOString() });
}
