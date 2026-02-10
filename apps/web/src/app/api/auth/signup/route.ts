import { NextRequest } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db, users, eq } from '@legacyapp/database';
import { lucia } from '@/lib/auth';
import { json, error, setSessionCookie } from '@/lib/api-utils';

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = signupSchema.safeParse(body);

    if (!result.success) {
      return error('Invalid input', 400);
    }

    const { email: rawEmail, password, name } = result.data;
    const email = rawEmail.toLowerCase();

    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      return error('Email already registered', 400);
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      email,
      passwordHash,
      name: name || email.split('@')[0],
    });

    const session = await lucia.createSession(userId, {});
    await setSessionCookie(session.id);

    return json({ success: true });
  } catch (err) {
    console.error('Signup error:', err);
    return error('Internal server error', 500);
  }
}
