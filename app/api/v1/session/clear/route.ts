/**
 * POST /api/v1/session/clear
 *
 * Explicitly deletes all Redis session keys associated with a conversation,
 * ensuring the next request starts with a completely clean slate.
 *
 * Body (JSON):
 *   { conversation_id: string }
 *
 * The endpoint requires a valid API key (same auth as /v1/messages).
 *
 * Keys deleted:
 *   context:summary:*         rolling summary
 *   opstate:v3:*              operational state (shell, workspace, artifacts)
 *   context:emergency:*       emergency compaction state
 *   context:workspace:*       companion workspace-root key
 *
 * Compacted-range keys (context:compacted:*) are NOT pattern-matched here
 * because Upstash/ioredis does not support SCAN in the compatibility layer.
 * They expire automatically via their TTL (default 6 h).
 */
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { extractToken, validateUserKey, validateAdminKey } from '@/lib/auth';
import { operationalStateKey } from '@/lib/context/operational-state';
import { stableHash } from '@/lib/utils/hash';

export const runtime = 'nodejs';

function deriveSummaryKeyFromId(conversationId: string): string {
  return `context:summary:${stableHash(conversationId)}`;
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { 'Allow': 'POST, OPTIONS' },
  });
}

export async function POST(req: Request) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const token = extractToken(req);
  if (!token) {
    return NextResponse.json(
      { error: { type: 'authentication_error', message: 'Missing API key' } },
      { status: 401 },
    );
  }
  const isValid = (await validateUserKey(token)) || (await validateAdminKey(req));
  if (!isValid) {
    return NextResponse.json(
      { error: { type: 'authentication_error', message: 'Invalid API key' } },
      { status: 401 },
    );
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { type: 'invalid_request_error', message: 'Request body must be valid JSON' } },
      { status: 400 },
    );
  }

  const conversationId =
    typeof (body as any)?.conversation_id === 'string'
      ? (body as any).conversation_id.trim()
      : null;

  if (!conversationId) {
    return NextResponse.json(
      { error: { type: 'invalid_request_error', message: '`conversation_id` is required' } },
      { status: 400 },
    );
  }

  // ── Delete all known session keys ─────────────────────────────────────────
  // The summary key is always `context:summary:<hash(conversationId)>` when
  // the client stores an explicit ID (which is what they would pass here).
  // As a safety net also try the raw conversationId form.
  const keysToDelete = [
    `context:summary:${stableHash(conversationId)}`,
    `context:summary:${conversationId}`,        // raw-ID form (edge case)
    operationalStateKey(conversationId),         // opstate:v3:<id>
    `context:emergency:${conversationId}`,
    `context:workspace:${conversationId}`,
  ];

  let deleted = 0;
  try {
    deleted = await redis.del(...keysToDelete);
  } catch (err) {
    console.error('[session/clear] Redis del failed:', err);
    return NextResponse.json(
      { error: { type: 'server_error', message: 'Failed to clear session data' } },
      { status: 500 },
    );
  }

  return NextResponse.json({
    cleared: true,
    conversation_id: conversationId,
    keys_deleted: deleted,
    note: 'Compacted range blocks expire automatically via TTL. Send a new request to start a fresh session.',
  });
}
