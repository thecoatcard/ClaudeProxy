import { redis } from '@/lib/redis';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    await redis.ping();
    return NextResponse.json({ status: 'ok', redis: true });
  } catch (err) {
    return NextResponse.json({ status: 'error', redis: false }, { status: 500 });
  }
}
