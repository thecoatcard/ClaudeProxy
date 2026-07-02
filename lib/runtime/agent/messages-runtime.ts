import { NextResponse } from 'next/server';
import { extractToken, validateUserKey } from '@/lib/auth';
import { incrementRequestCount, recordLatency, recordTokens } from '@/lib/metrics';
import { tryOptimizations } from '@/lib/transformers/optimizations';
import { createRequestLogger } from '@/lib/logging/event-logger';
import { agentRuntime } from './runtime';

type RuntimeRequestBody = {
  model?: string;
  stream?: boolean;
  thinking?: {
    type?: string;
  };
  tools?: Array<{ name?: string }>;
  messages?: Array<{ role?: string; content?: unknown }>;
  system?: unknown;
};

export const runtime = 'nodejs';
export const maxDuration = 2700;

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS, HEAD',
      'Anthropic-Version': '2023-06-01',
    },
  });
}

export async function HEAD() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS, HEAD',
      'Anthropic-Version': '2023-06-01',
    },
  });
}

export async function POST(req: Request) {
  const startTime = Date.now();
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const log = createRequestLogger(requestId);

  log.info('ACTIVITY', 'Request started', { metadata: { method: 'POST', path: '/api/v1/messages' } });

  const token = extractToken(req);
  if (!token) {
    return NextResponse.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } }, { status: 401 });
  }

  let body: RuntimeRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }, { status: 400 });
  }

  const { model, stream } = body;
  if (!model) {
    return NextResponse.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Model is required' } }, { status: 400 });
  }

  const isValid = await validateUserKey(token);
  if (!isValid) {
    return NextResponse.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } }, { status: 401 });
  }

  const optimized = await tryOptimizations(body);
  if (optimized) {
    await recordLatency(Date.now() - startTime);
    await recordTokens(optimized.usage.input_tokens, optimized.usage.output_tokens, { model, userToken: token });
    return NextResponse.json(optimized);
  }

  await incrementRequestCount({ model, userToken: token });
  log.info('ACTIVITY', 'Delegating request to agent runtime', { metadata: { stream: Boolean(stream) } });

  const response = await agentRuntime.handle({
    body,
    token,
    requestId,
    requestedModel: model,
    stream: Boolean(stream),
    startedAt: startTime,
  });

  return response;
}
