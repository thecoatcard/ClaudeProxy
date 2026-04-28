import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export async function POST(req: Request) {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(/admin_session=([^;]+)/);
  if (match) {
    const sid = match[1];
    await redis.del(`admin:session:${sid}`);
  }

  const response = NextResponse.json({ success: true });
  response.cookies.delete('admin_session');
  return response;
}
