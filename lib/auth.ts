import { redis } from './redis';

export function extractToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.headers.get('x-api-key');
}

export async function validateUserKey(token: string): Promise<boolean> {
  const keyObj = await redis.hgetall(`user:key:${token}`);
  if (!keyObj || keyObj.status !== 'active') {
    return false;
  }
  await redis.hincrby(`user:key:${token}`, 'usage_count', 1);
  await redis.hset(`user:key:${token}`, { last_used: Math.floor(Date.now() / 1000) });
  return true;
}

export async function validateAdminKey(req: Request): Promise<boolean> {
  // Support both header and cookie
  const authHeader = req.headers.get('authorization');
  const masterKey = process.env.MASTER_API_KEY;
  if (masterKey && authHeader?.startsWith('Bearer ')) {
    if (authHeader.slice(7) === masterKey) return true;
  }

  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(/admin_session=([^;]+)/);
  if (match) {
    const sid = match[1];
    const session = await redis.get(`admin:session:${sid}`);
    if (session) {
      return true;
    }
  }

  return false;
}
