import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';

export async function GET(req: Request) {
  const isAuthenticated = await validateAdminKey(req);
  if (!isAuthenticated) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) {
    return NextResponse.json({ error: 'Admin authentication is not configured' }, { status: 503 });
  }

  return NextResponse.json({
    authenticated: true,
    email: adminEmail,
  });
}
