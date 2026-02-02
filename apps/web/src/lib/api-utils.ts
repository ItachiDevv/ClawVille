import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { lucia } from './auth';

export function json<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function error(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function validateSession() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(lucia.sessionCookieName)?.value ?? null;

  if (!sessionId) {
    return { user: null, session: null };
  }

  const result = await lucia.validateSession(sessionId);

  if (result.session && result.session.fresh) {
    const sessionCookie = lucia.createSessionCookie(result.session.id);
    cookieStore.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
  }

  if (!result.session) {
    const sessionCookie = lucia.createBlankSessionCookie();
    cookieStore.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
  }

  return result;
}

export async function requireAuth() {
  const { user, session } = await validateSession();

  if (!user || !session) {
    return { error: error('Authentication required', 401), user: null, session: null };
  }

  return { error: null, user, session };
}

export async function setSessionCookie(sessionId: string) {
  const cookieStore = await cookies();
  const sessionCookie = lucia.createSessionCookie(sessionId);
  cookieStore.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  const sessionCookie = lucia.createBlankSessionCookie();
  cookieStore.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
}
