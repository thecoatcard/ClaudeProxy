import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';
import { resetAllKeys } from '@/lib/key-manager';

export const runtime = 'edge';

export async function POST(req: Request) {
  // 1. Auth check
  const isAdmin = await validateAdminKey(req);
  if (!isAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await resetAllKeys();
    return NextResponse.json({ success: true, message: "All keys have been reset and activated." });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to reset keys" }, { status: 500 });
  }
}
