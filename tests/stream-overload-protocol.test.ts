jest.mock('../lib/transformers/request', () => ({
  transformRequestToGemini: jest.fn(async () => ({
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    webSearchConfig: null,
    requestContext: undefined,
  })),
}));

jest.mock('../lib/retry-engine', () => ({
  executeWithRetry: jest.fn(),
}));

jest.mock('../lib/metrics', () => ({
  incrementErrorCount: jest.fn(async () => {}),
}));

jest.mock('../lib/context/emergency-compactor', () => ({
  performEmergencyCompaction: jest.fn(async () => ({ compacted: false, body: null })),
}));

jest.mock('../lib/recovery/overload-recovery', () => ({
  recoverFromOverload: jest.fn(async () => ({
    recovered: false,
    newModel: null,
    newKeyId: null,
    compacted: false,
    backoffMs: 0,
    attempt: 1,
  })),
}));

import { transformStream } from '../lib/transformers/stream';
import { executeWithRetry } from '../lib/retry-engine';

async function collect(gen: AsyncGenerator<string, void, unknown>): Promise<string> {
  let out = '';
  for await (const chunk of gen) out += chunk;
  return out;
}

describe('stream overload protocol', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('overload before stream start never shows capacity pressure text, emits message_stop', async () => {
    (executeWithRetry as jest.Mock).mockRejectedValue(new Error('overloaded_error'));

    const output = await collect(transformStream({ messages: [] }, 'claude-opus', 'gemini-2.5-flash', 'u1'));
    expect(output).not.toContain('temporary model capacity pressure');
    expect(output).not.toContain('compacted context and attempted fallback');
    expect(output).toContain('event: message_stop');
  });

  test('non-overload failure still emits gateway error and message_stop', async () => {
    (executeWithRetry as jest.Mock).mockRejectedValueOnce(new Error('network unreachable'));

    const output = await collect(transformStream({ messages: [] }, 'claude-opus', 'gemini-2.5-flash', 'u1'));
    expect(output).toContain('event: error');
    expect(output).toContain('network unreachable');
    expect(output).toContain('event: message_stop');
  });

  test('overload non-ok response never shows capacity pressure text, emits message_stop', async () => {
    (executeWithRetry as jest.Mock).mockResolvedValue({
      ok: false,
      status: 529,
      json: async () => ({ error: { message: 'resource_exhausted overload' } }),
    });

    const output = await collect(transformStream({ messages: [] }, 'claude-opus', 'gemini-2.5-flash', 'u1'));
    expect(output).not.toContain('temporary model capacity pressure');
    expect(output).not.toContain('compacted context and attempted fallback');
    expect(output).toContain('event: message_stop');
  });
});
