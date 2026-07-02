import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export async function POST(req: Request) {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(/admin_session=([^;]+)/);
  const response = NextResponse.json({ success: true });

  if (match) {
    // Signed sessions are invalidated by clearing the cookie. Keep deletion for
    // legacy opaque Redis sessions and do not fail logout during Redis outages.
    const sid = decodeURIComponent(match[1]);
    if (!sid.includes('.')) await redis.del(`admin:session:${sid}`).catch(() => {});
  }

  response.cookies.set('admin_session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
