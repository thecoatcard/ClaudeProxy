import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export async function POST(req: Request) {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(/admin_session=([^;]+)/);
  const response = NextResponse.json({ success: true });

  if (match) {
    await redis.del(`admin:session:${match[1]}`);
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