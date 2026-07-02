const validateUserKey = jest.fn(async () => false);
const tryOptimizations = jest.fn(async () => ({
  id: 'msg_fast_path',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'fast path' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}));

jest.mock('@/lib/auth', () => ({
  extractToken: () => 'invalid-key',
  validateUserKey,
}));
jest.mock('@/lib/transformers/optimizations', () => ({ tryOptimizations }));
jest.mock('@/lib/model-router', () => ({
  getModelMapping: jest.fn(async () => ({
    primary: 'gemini-test',
    fallbacks: [],
    routingSource: 'test',
    taskType: 'CHAT',
    routeVersion: '1',
  })),
}));
jest.mock('@/lib/logger', () => ({ logRequest: jest.fn() }));
jest.mock('@/lib/metrics', () => ({
  incrementRequestCount: jest.fn(),
  incrementErrorCount: jest.fn(),
  recordLatency: jest.fn(),
  recordTokens: jest.fn(),
}));
jest.mock('@/lib/activity', () => ({ logActivity: jest.fn(), maskToken: jest.fn() }));
jest.mock('@/lib/logging/event-logger', () => ({
  createRequestLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));
jest.mock('@/lib/logging/error-summarizer', () => ({ errorOneLiner: jest.fn() }));
jest.mock('@/lib/transformers/request', () => ({ transformRequestToGemini: jest.fn() }));
jest.mock('@/lib/transformers/response', () => ({ transformGeminiToAnthropic: jest.fn() }));
jest.mock('@/lib/transformers/stream', () => ({ transformStream: jest.fn() }));
jest.mock('@/lib/retry-engine', () => ({ executeWithRetry: jest.fn() }));
jest.mock('@/lib/transformers/errors', () => ({ transformError: jest.fn() }));
jest.mock('@/lib/tools/search-executor', () => ({ runWithWebSearch: jest.fn() }));
jest.mock('@/lib/gemini-adapter', () => ({ callGemini: jest.fn() }));
jest.mock('@/lib/key-manager', () => ({ getHealthiestKeyObj: jest.fn() }));

describe('messages route authentication order', () => {
  it('rejects an invalid key before evaluating the local optimization fast path', async () => {
    const { POST } = await import('@/app/api/v1/messages/route');
    const req = new Request('http://localhost/api/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'invalid-key' },
      body: JSON.stringify({
        model: 'claude-test',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'quota' }],
      }),
    });

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(validateUserKey).toHaveBeenCalledWith('invalid-key');
    expect(tryOptimizations).not.toHaveBeenCalled();
  });
});
