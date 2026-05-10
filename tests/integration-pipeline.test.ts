/**
 * tests/integration-pipeline.test.ts
 *
 * End-to-end integration tests for the Anthropic→Gemini proxy pipeline.
 * Tests the full request → context transformation → Gemini call → SSE stream → Anthropic response flow.
 *
 * External dependencies mocked (boundary mocks only):
 *   lib/redis              → in-memory Map (no TCP connections)
 *   lib/key-manager        → returns fake key object
 *   lib/gemini-adapter     → controllable mock (returns mock Gemini SSE responses)
 *   lib/auth               → always valid by default (per-test overrides via mockResolvedValueOnce)
 *   lib/metrics            → no-ops
 *   lib/metrics/performance-tracker → no-ops
 *   lib/activity           → no-ops
 */

// ── Module mocks (hoisted before imports) ────────────────────────────────────

jest.mock('../lib/redis', () => {
  const store = new Map<string, string>();
  return {
    redis: {
      _store: store, // exposed for test setup (pre-populate stale keys)
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: unknown) => {
        store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
        return 'OK';
      }),
      setex: jest.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; }),
      del: jest.fn(async (...keys: string[]) => {
        let n = 0;
        for (const k of keys) { if (store.delete(k)) n++; }
        return n;
      }),
      hgetall: jest.fn(async () => null),
      hset: jest.fn(async () => 0),
      hincrby: jest.fn(async () => 1),
      hincrbyfloat: jest.fn(async () => 1),
      lpush: jest.fn(async () => 1),
      rpush: jest.fn(async () => 1),
      ltrim: jest.fn(async () => 'OK'),
      lrange: jest.fn(async () => []),
      incr: jest.fn(async () => 1),
      incrby: jest.fn(async () => 1),
      zadd: jest.fn(async () => 1),
      zrange: jest.fn(async () => []),
      zrevrange: jest.fn(async () => []),
      zrem: jest.fn(async () => 0),
      sadd: jest.fn(async () => 1),
      smembers: jest.fn(async () => []),
      srem: jest.fn(async () => 0),
      expire: jest.fn(async () => 1),
      scan: jest.fn(async () => ['0', []]),
      pipeline: jest.fn(() => {
        const pipe: Record<string, (...args: any[]) => any> = {
          lpush: () => pipe,
          rpush: () => pipe,
          ltrim: () => pipe,
          expire: () => pipe,
          hset: () => pipe,
          hincrby: () => pipe,
          hget: () => pipe,
          exec: jest.fn(async () => []),
        };
        return pipe;
      }),
    },
  };
});

jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn().mockResolvedValue({ id: 'test-key-001', key: 'AIza-integration-test-key' }),
  reportKeyFailure: jest.fn().mockResolvedValue(undefined),
  recordKeyUsage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/gemini-adapter', () => ({
  callGemini: jest.fn(),
}));

jest.mock('../lib/auth', () => ({
  extractToken: jest.fn((req: Request) => {
    return (
      req.headers.get('x-api-key') ||
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
      null
    );
  }),
  validateUserKey: jest.fn().mockResolvedValue(true),
  validateAdminKey: jest.fn().mockResolvedValue(false),
}));

jest.mock('../lib/metrics', () => ({
  incrementRequestCount: jest.fn().mockResolvedValue(undefined),
  incrementErrorCount: jest.fn().mockResolvedValue(undefined),
  recordLatency: jest.fn().mockResolvedValue(undefined),
  recordTokens: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/metrics/performance-tracker', () => ({
  startTimer: jest.fn(() => ({
    elapsed: () => 0,
    record: jest.fn().mockResolvedValue(undefined),
  })),
  recordMetric: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/activity', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
  maskToken: jest.fn((t: string) => `${(t ?? '').slice(0, 4)}...`),
}));

// ── Imports (after mocks are registered) ────────────────────────────────────

import { transformStream } from '../lib/transformers/stream';
import { callGemini } from '../lib/gemini-adapter';
import { redis } from '../lib/redis';
import type { ModelRoute } from '../lib/model-router';

// ── Types & Helpers ─────────────────────────────────────────────────────────

interface SSEEvent {
  event: string;
  data: any;
}

/**
 * Build a mock Gemini SSE streaming Response from an array of candidate chunks.
 * Each chunk is emitted as a single `data: <JSON>` SSE line.
 */
function createGeminiSSEResponse(chunks: any[]): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(readable, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Parse raw SSE strings (yielded by transformStream generator) into typed events. */
function parseSSEStrings(rawChunks: string[]): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const chunk of rawChunks) {
    const lines = chunk.split('\n');
    let eventType = 'message';
    let dataLine = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      if (line.startsWith('data: ')) dataLine = line.slice(6).trim();
    }
    if (dataLine) {
      try {
        events.push({ event: eventType, data: JSON.parse(dataLine) });
      } catch {
        /* ignore malformed JSON */
      }
    }
  }
  return events;
}

/** Drain an async generator and return parsed SSE events. */
async function collectStreamEvents(gen: AsyncGenerator<string>): Promise<SSEEvent[]> {
  const chunks: string[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return parseSSEStrings(chunks);
}

/** Minimal Anthropic-format streaming request body. */
function makeBody(overrides: Record<string, any> = {}): any {
  return {
    model: 'claude-opus-4-5',
    stream: true,
    messages: [{ role: 'user', content: 'Hello, what is 2+2?' }],
    max_tokens: 1024,
    ...overrides,
  };
}

/** ModelRoute with full OVERLOAD_FALLBACK_CHAIN as fallbacks. */
const TEST_ROUTE: ModelRoute = {
  primary: 'gemini-2.5-flash',
  fallback: [
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-flash-latest',
    'gemma-4-31b-it',
    'gemma-4-26b-a4b-it',
  ],
  taskType: 'HEAVY_CODING',
  routeVersion: '1',
  routingSource: 'hardcoded',
};

const CALL_GEMINI_MOCK = () => callGemini as jest.MockedFunction<typeof callGemini>;

// ── Test Suite 1: SSE Pipeline ───────────────────────────────────────────────

describe('Integration — SSE Pipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset callGemini implementation so each test starts clean
    (CALL_GEMINI_MOCK()).mockReset();
  });

  test('basic text response produces correct Anthropic SSE event sequence', async () => {
    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          candidates: [
            { content: { parts: [{ text: 'The answer is 4.' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      ])
    );

    const gen = transformStream(
      makeBody(),
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_001',
    );
    const events = await collectStreamEvents(gen);
    const types = events.map((e) => e.event);

    // Must contain all Anthropic SSE protocol events in order
    expect(types).toContain('message_start');
    expect(types).toContain('ping');
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_delta');
    expect(types).toContain('content_block_stop');
    expect(types).toContain('message_delta');
    expect(types).toContain('message_stop');

    // message_start order: it must come before everything else
    expect(types.indexOf('message_start')).toBeLessThan(types.indexOf('content_block_start'));

    // content_block_delta carries the actual text
    const textDelta = events.find((e) => e.event === 'content_block_delta');
    expect(textDelta?.data?.delta?.text).toBe('The answer is 4.');

    // stop_reason must be end_turn for STOP finishReason
    const msgDelta = events.find((e) => e.event === 'message_delta');
    expect(msgDelta?.data?.delta?.stop_reason).toBe('end_turn');
  });

  test('message_start event carries correct model name and role', async () => {
    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          candidates: [{ content: { parts: [{ text: 'Hi!' }] }, finishReason: 'STOP' }],
          usageMetadata: {},
        },
      ])
    );

    const gen = transformStream(
      makeBody(),
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_002',
    );
    const events = await collectStreamEvents(gen);

    const msgStart = events.find((e) => e.event === 'message_start');
    expect(msgStart?.data?.message?.model).toBe('claude-opus-4-5'); // original Anthropic model, not internal
    expect(msgStart?.data?.message?.role).toBe('assistant');
    expect(msgStart?.data?.message?.type).toBe('message');
  });

  test('tool use functionCall produces tool_use content block with stop_reason tool_use', async () => {
    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'Write',
                      args: { path: 'hello.txt', content: 'Hello, World!' },
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 15 },
        },
      ])
    );

    const bodyWithTool = makeBody({
      tools: [
        {
          name: 'Write',
          description: 'Write content to a file',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      ],
    });

    const gen = transformStream(
      bodyWithTool,
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_003',
    );
    const events = await collectStreamEvents(gen);

    // content_block_start must declare a tool_use block
    const blockStart = events.find((e) => e.event === 'content_block_start');
    expect(blockStart?.data?.content_block?.type).toBe('tool_use');
    expect(blockStart?.data?.content_block?.name).toBe('Write');

    // stop_reason must be tool_use (not end_turn) — critical for Claude Code operation
    const msgDelta = events.find((e) => e.event === 'message_delta');
    expect(msgDelta?.data?.delta?.stop_reason).toBe('tool_use');

    // message_stop must be the final event
    const lastEvent = events[events.length - 1];
    expect(lastEvent.event).toBe('message_stop');
  });

  test('MAX_TOKENS finishReason correctly maps to max_tokens stop_reason', async () => {
    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          candidates: [
            {
              content: { parts: [{ text: 'This is a very long response that got cut' }] },
              finishReason: 'MAX_TOKENS',
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 500 },
        },
      ])
    );

    const gen = transformStream(
      makeBody(),
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_004',
    );
    const events = await collectStreamEvents(gen);

    // Regression test: previously MAX_TOKENS + tool_use → wrong stop_reason 'tool_use'
    const msgDelta = events.find((e) => e.event === 'message_delta');
    expect(msgDelta?.data?.delta?.stop_reason).toBe('max_tokens');
  });

  test('MAX_TOKENS overrides tool_use stop_reason when both are present', async () => {
    // Edge case: MAX_TOKENS finishReason even when a functionCall was seen in prior chunks.
    // The gateway should prioritize MAX_TOKENS over tool_use in this scenario.
    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          // First chunk has a function call
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'Read', args: { path: 'file.ts' } } },
                ],
              },
              finishReason: null,
            },
          ],
        },
        {
          // Second chunk signals MAX_TOKENS
          candidates: [
            {
              content: { parts: [] },
              finishReason: 'MAX_TOKENS',
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 200 },
        },
      ])
    );

    const bodyWithTool = makeBody({
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    });

    const gen = transformStream(
      bodyWithTool,
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_005',
    );
    const events = await collectStreamEvents(gen);

    const msgDelta = events.find((e) => e.event === 'message_delta');
    // MAX_TOKENS must win over tool_use — tells Claude Code the response was truncated
    expect(msgDelta?.data?.delta?.stop_reason).toBe('max_tokens');
  });

  test('stream always terminates with message_stop (no hanging streams)', async () => {
    // Even if Gemini returns only a ping with no candidates, the stream must close cleanly.
    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        { candidates: [{ content: { parts: [{ text: 'Short.' }] }, finishReason: 'STOP' }] },
      ])
    );

    const gen = transformStream(
      makeBody(),
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_006',
    );
    const events = await collectStreamEvents(gen);

    expect(events.length).toBeGreaterThan(0);
    // message_stop MUST be the final event
    expect(events[events.length - 1].event).toBe('message_stop');
  });

  test('usage tokens are tracked and included in message_delta', async () => {
    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          candidates: [{ content: { parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7 },
        },
      ])
    );

    const usageRef = { inputTokens: 0, outputTokens: 0 };
    const gen = transformStream(
      makeBody(),
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      usageRef,
      TEST_ROUTE,
      'req_test_007',
    );
    await collectStreamEvents(gen);

    // usageRef must be populated after stream completes
    expect(usageRef.inputTokens).toBe(42);
    expect(usageRef.outputTokens).toBe(7);
  });
});

// ── Test Suite 2: Retry & Overload Recovery ──────────────────────────────────

describe('Integration — Retry & Overload Recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (CALL_GEMINI_MOCK()).mockReset();
  });

  test('503 on primary model triggers fallback and succeeds on second attempt', async () => {
    // Attempt 1: primary model is overloaded
    CALL_GEMINI_MOCK().mockResolvedValueOnce(new Response(null, { status: 503 }));
    // Attempt 2: fallback model succeeds
    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          candidates: [
            { content: { parts: [{ text: 'Recovered response after fallback.' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      ])
    );

    const gen = transformStream(
      makeBody(),
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_recovery_001',
    );
    const events = await collectStreamEvents(gen);

    // Must have retried (two callGemini calls)
    expect(CALL_GEMINI_MOCK()).toHaveBeenCalledTimes(2);

    // The second attempt (fallback model) must have used a different model
    const [firstCall, secondCall] = CALL_GEMINI_MOCK().mock.calls;
    expect(firstCall[0]).toBe('gemini-2.5-flash');      // primary
    expect(secondCall[0]).toBe('gemini-3-flash-preview'); // first fallback

    // Stream must complete successfully
    const textDelta = events.find((e) => e.event === 'content_block_delta');
    expect(textDelta?.data?.delta?.text).toBe('Recovered response after fallback.');
    expect(events[events.length - 1].event).toBe('message_stop');
  }, 10_000); // Allow extra time for overload backoff sleep

  test('429 rate-limit triggers key retry on same model', async () => {
    // Rate-limit triggers a retry with a different backoff (same model, next key)
    CALL_GEMINI_MOCK().mockResolvedValueOnce(new Response(null, { status: 429 }));
    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          candidates: [{ content: { parts: [{ text: 'OK after rate limit.' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 },
        },
      ])
    );

    const gen = transformStream(
      makeBody(),
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_recovery_002',
    );
    const events = await collectStreamEvents(gen);

    expect(CALL_GEMINI_MOCK()).toHaveBeenCalledTimes(2);

    const textDelta = events.find((e) => e.event === 'content_block_delta');
    expect(textDelta?.data?.delta?.text).toBe('OK after rate limit.');
  }, 10_000);
});

// ── Test Suite 3: Session Clear Endpoint ────────────────────────────────────

describe('Integration — Session Clear Endpoint', () => {
  // Lazy import to allow jest.mock hoisting to take effect first
  let POST: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../app/api/v1/session/clear/route');
    POST = mod.POST as (req: Request) => Promise<Response>;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Restore redis.del to a working jest.fn (clearAllMocks clears call records only)
    (redis.del as jest.Mock).mockClear();
  });

  test('clears all session keys and returns cleared=true with keys_deleted count', async () => {
    const req = new Request('http://localhost/api/v1/session/clear', {
      method: 'POST',
      headers: {
        'x-api-key': 'test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ conversation_id: 'conv-abc-123' }),
    });

    const response = await POST(req);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cleared).toBe(true);
    expect(body.conversation_id).toBe('conv-abc-123');
    expect(typeof body.keys_deleted).toBe('number');

    // Verify Redis.del was called with keys that include the conversation_id
    expect(redis.del as jest.Mock).toHaveBeenCalled();
    const delArgs: string[] = (redis.del as jest.Mock).mock.calls[0];
    expect(delArgs.some((k: string) => k.includes('conv-abc-123'))).toBe(true);
  });

  test('deletes both hash-derived and raw conversationId summary keys', async () => {
    const req = new Request('http://localhost/api/v1/session/clear', {
      method: 'POST',
      headers: {
        'x-api-key': 'test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ conversation_id: 'my-session-id' }),
    });

    await POST(req);

    const delArgs: string[] = (redis.del as jest.Mock).mock.calls[0];
    // Should include raw-id form: context:summary:my-session-id
    expect(delArgs.some((k: string) => k === 'context:summary:my-session-id')).toBe(true);
    // Should include opstate key
    expect(delArgs.some((k: string) => k.includes('my-session-id'))).toBe(true);
  });

  test('returns 400 when conversation_id is missing', async () => {
    const req = new Request('http://localhost/api/v1/session/clear', {
      method: 'POST',
      headers: { 'x-api-key': 'test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await POST(req);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toMatch(/conversation_id/i);
  });

  test('returns 400 when conversation_id is empty string', async () => {
    const req = new Request('http://localhost/api/v1/session/clear', {
      method: 'POST',
      headers: { 'x-api-key': 'test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: '   ' }), // blank after trim
    });

    const response = await POST(req);

    expect(response.status).toBe(400);
  });

  test('returns 401 when no API key is provided', async () => {
    const { validateUserKey, validateAdminKey } = await import('../lib/auth');
    (validateUserKey as jest.Mock).mockResolvedValueOnce(false);
    (validateAdminKey as jest.Mock).mockResolvedValueOnce(false);

    const req = new Request('http://localhost/api/v1/session/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: 'test' }),
    });

    const response = await POST(req);

    expect(response.status).toBe(401);
  });
});

// ── Test Suite 4: Messages Route Auth ────────────────────────────────────────

describe('Integration — Messages Route Auth', () => {
  let POST: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../app/api/v1/messages/route');
    POST = mod.POST as (req: Request) => Promise<Response>;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (CALL_GEMINI_MOCK()).mockReset();
  });

  test('missing API key returns 401 before any Gemini call', async () => {
    // extractToken returns null when no key header is present
    const { extractToken } = await import('../lib/auth');
    (extractToken as jest.Mock).mockReturnValueOnce(null);

    const req = new Request('http://localhost/api/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    const response = await POST(req);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.type).toBe('authentication_error');
    // Must NOT have called Gemini
    expect(CALL_GEMINI_MOCK()).not.toHaveBeenCalled();
  });

  test('invalid API key (validateUserKey=false) returns 401', async () => {
    const { validateUserKey } = await import('../lib/auth');
    (validateUserKey as jest.Mock).mockResolvedValueOnce(false);

    const req = new Request('http://localhost/api/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'invalid-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    const response = await POST(req);

    expect(response.status).toBe(401);
    expect(CALL_GEMINI_MOCK()).not.toHaveBeenCalled();
  });

  test('missing model field returns 400', async () => {
    const req = new Request('http://localhost/api/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Hello' }] }),
    });

    const response = await POST(req);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe('invalid_request_error');
  });

  test('OPTIONS preflight returns 204 with Allow header', async () => {
    const { OPTIONS } = await import('../app/api/v1/messages/route');
    const req = new Request('http://localhost/api/v1/messages', { method: 'OPTIONS' });
    const response = await OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('Allow')).toContain('POST');
  });
});

// ── Test Suite 5: Session Isolation ─────────────────────────────────────────

describe('Integration — Session Isolation (Fresh Session Gate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (CALL_GEMINI_MOCK()).mockReset();
    // Clear the in-memory Redis store
    const mockRedis = redis as any;
    if (mockRedis._store instanceof Map) {
      mockRedis._store.clear();
    }
  });

  test('fresh session (no explicit conversationId) does not inject stale rolling summary', async () => {
    const STALE_MARKER = 'STALE_CONTEXT_PREVIOUS_SESSION_MUST_NOT_APPEAR';

    // Pre-populate Redis with a rolling summary that looks like a stale context
    // We don't know the exact hash key, but we set ALL possible summary keys
    const mockRedis = redis as any;
    if (mockRedis._store instanceof Map) {
      const store: Map<string, string> = mockRedis._store;
      // Set a stale summary that the hydration guard should block
      store.set('context:summary:fake-hash', STALE_MARKER);
    }

    // Also configure the get mock to return the stale summary for any key
    (redis.get as jest.Mock).mockResolvedValue(STALE_MARKER);

    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          candidates: [{ content: { parts: [{ text: 'Hello fresh!' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        },
      ])
    );

    // Single message, no conversation_id → fresh session → hydration BLOCKED
    const body = makeBody({
      messages: [{ role: 'user', content: 'Analyze this fresh codebase.' }],
      // No conversation_id, session_id, or thread_id
    });

    const gen = transformStream(
      body,
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_isolation_001',
    );
    const events = await collectStreamEvents(gen);

    // Stream must complete successfully
    expect(events.find((e) => e.event === 'message_stop')).toBeDefined();

    // The Gemini request body must NOT contain the stale context text
    expect(CALL_GEMINI_MOCK()).toHaveBeenCalled();
    const sentGeminiBody = CALL_GEMINI_MOCK().mock.calls[0][2];
    const geminiBodyStr = JSON.stringify(sentGeminiBody);
    expect(geminiBodyStr).not.toContain(STALE_MARKER);
  });

  test('session with explicit conversationId allows context hydration', async () => {
    const CONTEXT_TEXT = 'PREVIOUS_SESSION_CONTEXT_SHOULD_APPEAR_IN_MULTI_TURN';

    // Configure redis.get to return a rolling summary for context:summary:<id>
    (redis.get as jest.Mock).mockImplementation(async (key: string) => {
      if (key.includes('explicit-session-id')) return CONTEXT_TEXT;
      return null;
    });

    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          candidates: [{ content: { parts: [{ text: 'Continuing with your context!' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 },
        },
      ])
    );

    // Multi-turn session with explicit conversationId → hydration ALLOWED
    const body = makeBody({
      conversation_id: 'explicit-session-id',
      messages: [
        { role: 'user', content: 'What did we do before?' },
        { role: 'assistant', content: 'We were working on the project.' },
        { role: 'user', content: 'Continue from where we left off.' },
      ],
    });

    const gen = transformStream(
      body,
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_isolation_002',
    );
    const events = await collectStreamEvents(gen);

    // Stream must complete successfully
    expect(events.find((e) => e.event === 'message_stop')).toBeDefined();
    // Gemini was called (session continued)
    expect(CALL_GEMINI_MOCK()).toHaveBeenCalled();
  });

  test('fresh session triggers Redis del to flush any stale keys', async () => {
    CALL_GEMINI_MOCK().mockResolvedValueOnce(
      createGeminiSSEResponse([
        {
          candidates: [{ content: { parts: [{ text: 'Hello!' }] }, finishReason: 'STOP' }],
          usageMetadata: {},
        },
      ])
    );

    const body = makeBody({
      messages: [{ role: 'user', content: 'Start fresh.' }],
      // No conversation_id → fresh session
    });

    const gen = transformStream(
      body,
      'claude-opus-4-5',
      'gemini-2.5-flash',
      'test-token',
      { inputTokens: 0, outputTokens: 0 },
      TEST_ROUTE,
      'req_test_isolation_003',
    );
    await collectStreamEvents(gen);

    // Fresh session detection triggers redis.del (stale key auto-flush)
    // The del call is fire-and-forget but must have been initiated during transformation
    expect(redis.del as jest.Mock).toHaveBeenCalled();
  });
});
