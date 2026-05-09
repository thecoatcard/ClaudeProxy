import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetRoutingTestAdapters,
  __setRoutingTestAdapters,
  getModelMapping,
  saveRoutingRegistry,
} from '../lib/model-router.js';

type KV = Record<string, string>;

class FakeRedis {
  private store: KV = {};

  async get<T = string>(key: string): Promise<T | null> {
    return (this.store[key] as T) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store[key] = String(value);
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.store[key] ?? '0') + 1;
    this.store[key] = String(next);
    return next;
  }
}

afterEach(async () => {
  await __resetRoutingTestAdapters();
});

describe('routing registry precedence', () => {
  test('Redis routing overrides local defaults', async () => {
    const fake = new FakeRedis();

    await __setRoutingTestAdapters({
      redisClient: fake,
      localRegistry: {
        'claude-sonnet-4-5': { primary: 'gemini-2.5-flash', fallback: ['gemini-flash-latest'] },
      },
    });

    await fake.set('models:registry', JSON.stringify({
      'claude-sonnet-4-5': { primary: 'gemini-3-flash-preview', fallback: ['gemini-2.5-flash'] },
    }));
    await fake.set('models:registry:version', '9');

    const mapping = await getModelMapping('claude-sonnet-4-5', { requestBody: { messages: [] } });
    assert.equal(mapping.routingSource, 'redis');
    assert.equal(mapping.routeVersion, '9');
    assert.equal(mapping.primary, 'gemini-3-flash-preview');
  });

  test('dashboard-style save updates runtime mapping immediately', async () => {
    const fake = new FakeRedis();
    await __setRoutingTestAdapters({ redisClient: fake, localRegistry: null });

    const before = await getModelMapping('claude-haiku-4-5', { requestBody: { messages: [] } });

    await saveRoutingRegistry({
      'claude-haiku-4-5': { primary: 'gemini-flash-latest', fallback: ['gemini-2.5-flash-lite'] },
    });

    const after = await getModelMapping('claude-haiku-4-5', { requestBody: { messages: [] } });
    assert.notEqual(after.primary, before.primary);
    assert.equal(after.primary, 'gemini-flash-latest');
    assert.equal(after.routingSource, 'redis');
  });
});
