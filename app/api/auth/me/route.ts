import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';

export async function GET(req: Request) {
  const isAuthenticated = await validateAdminKey(req);
  if (isAuthenticated) {
    return NextResponse.json({ authenticated: true, email: process.env.ADMIN_EMAIL || 'kumaranand43856@gmail.com' });
  }
  return NextResponse.json({ authenticated: false }, { status: 401 });
}
