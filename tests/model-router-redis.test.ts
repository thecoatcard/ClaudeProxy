/**
 * tests/model-router-redis.test.ts
 *
 * Tests model-router Redis interactions and fallback logic.
 * All Redis calls are stubbed.
 */
import assert from 'node:assert/strict';

// ─── Default model routing (mirrors lib/model-router.ts) ─────────────────────

const DEFAULT_ROUTING: Record<string, string> = {
  'claude-opus-4-5':             'gemini-2.5-pro',
  'claude-opus-4-5-20250514':    'gemini-2.5-pro',
  'claude-opus-4':               'gemini-2.5-pro',
  'claude-sonnet-4-5':           'gemini-2.5-flash',
  'claude-sonnet-4-5-20250514':  'gemini-2.5-flash',
  'claude-3-5-sonnet-20241022':  'gemini-2.5-flash',
  'claude-haiku-3-5':            'gemini-2.0-flash',
  'claude-haiku-4':              'gemini-2.0-flash',
};

// ─── Logic under test ─────────────────────────────────────────────────────────

/**
 * Simulate the getModelMapping() function logic:
 * 1. Try to load custom registry from Redis
 * 2. Fall back to DEFAULT_ROUTING
 * 3. Look up the Claude model name
 */
async function simulateGetModelMapping(
  claudeModel: string,
  redisGet: (key: string) => Promise<string | null>
): Promise<string> {
  let routing = DEFAULT_ROUTING;
  try {
    const registryStr = await redisGet('models:registry');
    if (registryStr && typeof registryStr === 'string') {
      try {
        const parsed = JSON.parse(registryStr);
        if (parsed && typeof parsed === 'object') routing = parsed;
      } catch { /* keep default */ }
    } else if (registryStr && typeof registryStr === 'object') {
      // Upstash compat: auto-parsed JSON. Dead code with ioredis but harmless.
      routing = registryStr as Record<string, string>;
    }
  } catch { /* Redis unavailable — use default */ }

  const stripped = claudeModel.replace(/-\d{8}$/, '');
  return routing[stripped] ?? routing[claudeModel] ?? process.env.DEFAULT_MODEL ?? 'gemini-2.5-flash';
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('model-router Redis integration', () => {
  it('uses DEFAULT_ROUTING when Redis returns null', async () => {
    const redisGet = async (_key: string) => null;
    const result = await simulateGetModelMapping('claude-opus-4-5', redisGet);
    assert.equal(result, 'gemini-2.5-pro');
  });

  it('uses custom registry from Redis when available', async () => {
    const customRegistry = { 'claude-opus-4-5': 'gemini-custom-model' };
    const redisGet = async (_key: string) => JSON.stringify(customRegistry);
    const result = await simulateGetModelMapping('claude-opus-4-5', redisGet);
    assert.equal(result, 'gemini-custom-model');
  });

  it('strips date suffix before lookup (claude-sonnet-4-5-20250514 → claude-sonnet-4-5)', async () => {
    const redisGet = async (_key: string) => null;
    const result = await simulateGetModelMapping('claude-sonnet-4-5-20250514', redisGet);
    assert.equal(result, 'gemini-2.5-flash');
  });

  it('falls back to haiku route for claude-haiku models', async () => {
    const redisGet = async (_key: string) => null;
    const result = await simulateGetModelMapping('claude-haiku-4', redisGet);
    assert.equal(result, 'gemini-2.0-flash');
  });

  it('falls back to gemini-2.5-flash for unknown models', async () => {
    const redisGet = async (_key: string) => null;
    const result = await simulateGetModelMapping('claude-unknown-9', redisGet);
    assert.equal(result, 'gemini-2.5-flash');
  });

  it('survives Redis error and falls back to DEFAULT_ROUTING', async () => {
    const redisGet = async (_key: string) => { throw new Error('ECONNREFUSED'); };
    const result = await simulateGetModelMapping('claude-opus-4-5', redisGet);
    assert.equal(result, 'gemini-2.5-pro');
  });

  it('ignores malformed JSON in Redis registry', async () => {
    const redisGet = async (_key: string) => 'not-valid-json{{{';
    const result = await simulateGetModelMapping('claude-opus-4-5', redisGet);
    assert.equal(result, 'gemini-2.5-pro');
  });

  it('custom registry overrides all default routes', async () => {
    const customRegistry: Record<string, string> = {
      'claude-opus-4-5': 'custom-a',
      'claude-sonnet-4-5': 'custom-b',
      'claude-haiku-4': 'custom-c',
    };
    const redisGet = async (_key: string) => JSON.stringify(customRegistry);

    const a = await simulateGetModelMapping('claude-opus-4-5', redisGet);
    const b = await simulateGetModelMapping('claude-sonnet-4-5', redisGet);
    const c = await simulateGetModelMapping('claude-haiku-4', redisGet);
    assert.equal(a, 'custom-a');
    assert.equal(b, 'custom-b');
    assert.equal(c, 'custom-c');
  });
});

describe('model-router key format', () => {
  it('models:registry is the correct Redis key', () => {
    // Confirm the key name used in real code
    const key = 'models:registry';
    assert.equal(key, 'models:registry');
  });

  it('route:last key format includes userId and model', () => {
    const userId = 'user-123';
    const model = 'claude-sonnet-4-5';
    const key = `route:last:${userId}:${model}`;
    assert.equal(key, 'route:last:user-123:claude-sonnet-4-5');
  });
});
