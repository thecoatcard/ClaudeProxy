import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { nanoid } from 'nanoid';

const LOGIN_WINDOW_SECS = 60;
const MAX_LOGIN_ATTEMPTS = 5;

function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim() || 'unknown';
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function POST(req: Request) {
  const { email, password } = await req.json();
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
  const rateLimitKey = `admin:login:attempts:${getClientIp(req)}`;

  try {
    const attempts = await redis.incr(rateLimitKey);
    if (attempts === 1) {
      await redis.expire(rateLimitKey, LOGIN_WINDOW_SECS);
    }
    if (attempts > MAX_LOGIN_ATTEMPTS) {
      return NextResponse.json({ error: 'Too many login attempts' }, { status: 429 });
    }
  } catch {
    // Best-effort protection only. Do not block all admin logins on Redis issues.
  }

  if (email !== adminEmail || password !== adminPassword) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const sid = nanoid(32);
  await redis.setex(`admin:session:${sid}`, 24 * 60 * 60, email);
  await redis.del(rateLimitKey).catch(() => {});

  const response = NextResponse.json({ success: true });
  response.cookies.set('admin_session', sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60,
  });
  return response;
}