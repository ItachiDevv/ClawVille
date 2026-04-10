import { NextRequest } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db, users, eq } from '@clawville/database';
import { lucia } from '@/lib/auth';
import { json, error, setSessionCookie } from '@/lib/api-utils';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = loginSchema.safeParse(body);

    if (!result.success) {
      return error('Invalid input', 400);
    }

    const { email: rawEmail, password } = result.data;
    const email = rawEmail.toLowerCase();

    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user || !user.passwordHash) {
      return error('Invalid email or password', 401);
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return error('Invalid email or password', 401);
    }

    const session = await lucia.createSession(user.id, {});
    await setSessionCookie(session.id);

    return json({ success: true });
  } catch (err) {
    console.error('Login error:', err);
    return error('Internal server error', 500);
  }
}
