import assert from 'node:assert/strict';
import {
  __resetRoutingTestAdapters,
  __setRoutingTestAdapters,
  forceReloadRouting,
  getModelMapping,
  saveRoutingRegistry,
} from '../lib/model-router.js';

class FakeRedis {
  private store: Record<string, string> = {};

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

describe('routing cache invalidation', () => {
  test('forceReloadRouting refreshes in-memory registry cache', async () => {
    const fake = new FakeRedis();
    await __setRoutingTestAdapters({ redisClient: fake, localRegistry: null });

    await fake.set('models:registry', JSON.stringify({
      'gemini-3.5-flash': { primary: 'gemini-3.5-flash', fallback: [] },
    }));
    await fake.set('models:registry:version', '1');

    const first = await getModelMapping('gemini-3.5-flash', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });
    assert.equal(first.routeVersion, '1');

    await fake.set('models:registry', JSON.stringify({
      'gemini-3.5-flash': { primary: 'gemini-flash-latest', fallback: [] },
    }));
    await fake.set('models:registry:version', '2');

    const reloaded = await forceReloadRouting();
    assert.equal(reloaded.version, '2');

    const second = await getModelMapping('gemini-3.5-flash', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });
    assert.equal(second.primary, 'gemini-flash-latest');
    assert.equal(second.routeVersion, '2');
  });

  test('saveRoutingRegistry increments version and applies without restart', async () => {
    const fake = new FakeRedis();
    await __setRoutingTestAdapters({ redisClient: fake, localRegistry: null });

    const before = await getModelMapping('gemma-4-31b-it', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });
    const initialVersion = before.routeVersion ?? '0';

    const diag = await saveRoutingRegistry({
      'gemma-4-31b-it': {
        primary: 'gemma-4-26b-a4b-it',
        fallback: ['gemma-4-31b-it'],
      },
    });

    const after = await getModelMapping('gemma-4-31b-it', {
      requestBody: makeTaskBody('Refactor the authentication module'),
    });
    assert.equal(diag.source, 'redis');
    assert.notEqual(diag.version, initialVersion);
    assert.equal(after.primary, 'gemma-4-26b-a4b-it');
  });
});
