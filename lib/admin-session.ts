import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_SECONDS = 24 * 60 * 60;

type SessionPayload = {
  email: string;
  exp: number;
  nonce: string;
};

function sessionSecret(): string | null {
  return process.env.MASTER_API_KEY || process.env.ADMIN_PASSWORD || null;
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

/** Create a self-verifying session so dashboard auth does not depend on Redis availability. */
export function createAdminSession(email: string): string {
  const secret = sessionSecret();
  if (!secret) throw new Error('Admin session secret is not configured');

  const payload: SessionPayload = {
    email,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyAdminSession(token: string): SessionPayload | null {
  const secret = sessionSecret();
  const separator = token.lastIndexOf('.');
  if (!secret || separator <= 0) return null;

  const encoded = token.slice(0, separator);
  const supplied = token.slice(separator + 1);
  const expected = sign(encoded, secret);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!payload.email || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

