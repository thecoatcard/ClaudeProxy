/**
 * tests/model-router-imports.test.ts
 *
 * Verifies that all public exports of lib/model-router are importable and
 * return valid shapes.  This guards against regression from path refactors.
 */

jest.mock('../lib/redis', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    incr: jest.fn().mockResolvedValue(1),
  },
}));

import {
  getModelMapping,
  forceReloadRouting,
  getRoutingRegistry,
  getEffectiveRoutingRegistry,
  getRoutingDiagnostics,
  saveRoutingRegistry,
  buildStickyRouteKey,
  HARD_DEFAULT_MODEL_ROUTING,
  DEFAULT_MODEL_ROUTING,
  ROUTING_REGISTRY_KEY,
  ROUTING_REGISTRY_VERSION_KEY,
} from '../lib/model-router';

describe('model-router public API surface', () => {
  test('all named exports are importable', () => {
    expect(typeof getModelMapping).toBe('function');
    expect(typeof forceReloadRouting).toBe('function');
    expect(typeof getRoutingRegistry).toBe('function');
    expect(typeof getEffectiveRoutingRegistry).toBe('function');
    expect(typeof getRoutingDiagnostics).toBe('function');
    expect(typeof saveRoutingRegistry).toBe('function');
    expect(typeof buildStickyRouteKey).toBe('function');
    expect(typeof HARD_DEFAULT_MODEL_ROUTING).toBe('object');
    expect(typeof DEFAULT_MODEL_ROUTING).toBe('object');
    expect(typeof ROUTING_REGISTRY_KEY).toBe('string');
    expect(typeof ROUTING_REGISTRY_VERSION_KEY).toBe('string');
  });

  test('getRoutingRegistry is identical to getEffectiveRoutingRegistry', () => {
    expect(getRoutingRegistry).toBe(getEffectiveRoutingRegistry);
  });

  test('HARD_DEFAULT_MODEL_ROUTING contains gemini-3.5-flash entries', () => {
    expect(HARD_DEFAULT_MODEL_ROUTING['gemini-3.5-flash']).toBeDefined();
    expect(HARD_DEFAULT_MODEL_ROUTING['gemini-3.5-flash'].primary).toBeTruthy();
  });

  test('getModelMapping resolves gemini-3.5-flash', async () => {
    const route = await getModelMapping('gemini-3.5-flash', {
      thinkingEnabled: false,
      requestBody: { messages: [{ role: 'user', content: 'hello' }] },
      userId: 'test-user',
    });
    expect(route.primary).toBeTruthy();
    expect(typeof route.primary).toBe('string');
    expect(Array.isArray(route.fallback)).toBe(true);
  });

  test('getModelMapping resolves gemini-2.5-flash-lite → fast model', async () => {
    const route = await getModelMapping('gemini-2.5-flash-lite', {
      thinkingEnabled: false,
      requestBody: { messages: [{ role: 'user', content: 'ping' }] },
      userId: 'test-user',
    });
    expect(route.primary).toBeTruthy();
  });

  test('getModelMapping accepts boolean overload (legacy)', async () => {
    const route = await getModelMapping('gemini-3.5-flash', false);
    expect(route.primary).toBeTruthy();
  });

  test('forceReloadRouting returns diagnostics object', async () => {
    const diag = await forceReloadRouting();
    expect(typeof diag.source).toBe('string');
    expect(typeof diag.version).toBe('string');
    expect(typeof diag.aliases).toBe('number');
    expect(typeof diag.loadedAt).toBe('number');
  });

  test('getRoutingRegistry returns record of model routes', async () => {
    const registry = await getRoutingRegistry();
    expect(typeof registry).toBe('object');
    expect(Object.keys(registry).length).toBeGreaterThan(0);
  });

  test('buildStickyRouteKey returns expected format', () => {
    const key = buildStickyRouteKey('user123', 'gemini-3.5-flash', '5');
    expect(key).toBe('route:last:v5:user123:gemini-3.5-flash');
  });
});
