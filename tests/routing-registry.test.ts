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

function makeTaskBody(text: string) {
  return { messages: [{ role: 'user', content: text }] };
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
        'gemini-3.5-flash': { primary: 'gemini-3.5-flash', fallback: ['gemini-2.5-flash'] },
      },
    });

    await fake.set('models:registry', JSON.stringify({
      'gemini-3.5-flash': { primary: 'gemini-flash-latest', fallback: ['gemini-2.5-flash'] },
    }));
    await fake.set('models:registry:version', '9');

    const mapping = await getModelMapping('gemini-3.5-flash', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });
    assert.equal(mapping.routingSource, 'redis');
    assert.equal(mapping.routeVersion, '9');
    assert.equal(mapping.primary, 'gemini-flash-latest');
  });

  test('dashboard-style save updates runtime mapping immediately', async () => {
    const fake = new FakeRedis();
    await __setRoutingTestAdapters({ redisClient: fake, localRegistry: null });

    const before = await getModelMapping('gemini-2.5-flash-lite', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });

    await saveRoutingRegistry({
      'gemini-2.5-flash-lite': { primary: 'gemini-3.1-flash-lite-preview', fallback: ['gemini-2.5-flash-lite'] },
    });

    const after = await getModelMapping('gemini-2.5-flash-lite', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });
    assert.notEqual(after.primary, before.primary);
    assert.equal(after.primary, 'gemini-3.1-flash-lite-preview');
    assert.equal(after.routingSource, 'redis');
  });
});
