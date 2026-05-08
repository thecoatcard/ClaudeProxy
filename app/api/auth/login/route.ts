import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { nanoid } from 'nanoid';

export async function POST(req: Request) {
  const { email, password } = await req.json();
  const adminEmail = process.env.ADMIN_EMAIL || 'kumaranand43856@gmail.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';

  if (email === adminEmail && password === adminPassword) {
    const sid = nanoid(32);
    await redis.setex(`admin:session:${sid}`, 24 * 60 * 60, email); // 24 hours
    
    const response = NextResponse.json({ success: true });
    response.cookies.set('admin_session', sid, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60
    });
    return response;
  }

  return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
}
