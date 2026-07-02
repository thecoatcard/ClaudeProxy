/**
 * POST /api/admin/keys/validate
 *
 * Validates a Gemini API key by making a minimal generateContent call.
 * Returns { valid, latencyMs, model, error? }.
 *
 * Body: { key: string }
 */
import { NextResponse } from 'next/server';
import { validateAdminKey } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VALIDATION_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function testGeminiKey(key: string): Promise<{ valid: boolean; latencyMs: number; error?: string; model?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(
      `${GEMINI_BASE}/${VALIDATION_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 3, temperature: 0 },
        }),
        signal: AbortSignal.timeout(12_000),
      }
    );
    const latencyMs = Date.now() - start;

    if (res.status === 200) {
      return { valid: true, latencyMs, model: VALIDATION_MODEL };
    }

    const body = await res.json().catch(() => ({}));
    const msg: string = body?.error?.message ?? `HTTP ${res.status}`;

    if (res.status === 429) {
      return { valid: true, latencyMs, model: VALIDATION_MODEL, error: `Rate limited: ${msg}` };
    }
    if (res.status === 400 && msg.toLowerCase().includes('api key')) {
      return { valid: false, latencyMs, error: 'Invalid API key' };
    }
    return { valid: false, latencyMs, error: msg };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, latencyMs, error: msg };
  }
}

export async function POST(req: Request) {
  if (!(await validateAdminKey(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const key = typeof body?.key === 'string' ? body.key.trim() : '';

  if (!key) {
    return NextResponse.json({ valid: false, error: 'key is required', latencyMs: 0 }, { status: 400 });
  }

  const result = await testGeminiKey(key);
  return NextResponse.json(result);
}

/**
 * POST /api/admin/keys/validate with body { keys: string[] }
 * Bulk-validate multiple keys. Returns array of results.
 */
export async function PUT(req: Request) {
  if (!(await validateAdminKey(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const keys: string[] = Array.isArray(body?.keys)
    ? body.keys.map((k: unknown) => String(k).trim()).filter(Boolean)
    : [];

  if (!keys.length) {
    return NextResponse.json({ error: 'keys array is required', results: [] }, { status: 400 });
  }

  // Validate up to 20 keys in parallel (avoid hammering the Gemini API)
  const chunk = keys.slice(0, 20);
  const results = await Promise.all(chunk.map((key) => testGeminiKey(key).then((r) => ({ key, ...r }))));
  return NextResponse.json({ results });
}
