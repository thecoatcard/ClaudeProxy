/**
 * tests/dashboard-routing.test.ts
 *
 * Tests for model routing table CRUD logic.
 * Run: npx tsx --test tests/dashboard-routing.test.ts
 */
import assert from 'node:assert/strict';

type RouteConfig = { primary: string; fallback: string[] };
type Routes = Record<string, RouteConfig>;

// ─────────────────────────────────────────────────────────────────────────────
// Pure route manipulation logic (mirrors ModelsPage component logic)
// ─────────────────────────────────────────────────────────────────────────────

function addRoute(routes: Routes, alias: string, primary: string, fallbacksStr: string): Routes {
  const fallback = fallbacksStr.split(',').map((x) => x.trim()).filter(Boolean);
  return {
    ...routes,
    [alias.trim().toLowerCase()]: { primary: primary.trim(), fallback },
  };
}

function deleteRoute(routes: Routes, name: string): Routes {
  const { [name]: _, ...rest } = routes;
  return rest;
}

function saveJsonRoutes(jsonValue: string): Routes {
  return JSON.parse(jsonValue);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Route addition', () => {
  it('adds a simple route with no fallbacks', () => {
    const routes: Routes = {};
    const next = addRoute(routes, 'claude-3-sonnet', 'gemini-1.5-pro', '');
    assert.ok('claude-3-sonnet' in next);
    assert.equal(next['claude-3-sonnet'].primary, 'gemini-1.5-pro');
    assert.deepEqual(next['claude-3-sonnet'].fallback, []);
  });

  it('adds a route with fallback chain', () => {
    const routes: Routes = {};
    const next = addRoute(routes, 'claude-opus', 'gemini-1.5-pro', 'gemini-1.5-flash, gemini-pro');
    assert.deepEqual(next['claude-opus'].fallback, ['gemini-1.5-flash', 'gemini-pro']);
  });

  it('normalizes alias to lowercase', () => {
    const routes: Routes = {};
    const next = addRoute(routes, 'CLAUDE-SONNET', 'gemini-1.5-pro', '');
    assert.ok('claude-sonnet' in next, 'alias must be lowercase');
    assert.ok(!('CLAUDE-SONNET' in next));
  });

  it('overwrites an existing alias', () => {
    const routes: Routes = { 'claude-haiku': { primary: 'gemini-flash', fallback: [] } };
    const next = addRoute(routes, 'claude-haiku', 'gemini-1.5-flash', '');
    assert.equal(next['claude-haiku'].primary, 'gemini-1.5-flash');
    assert.equal(Object.keys(next).length, 1);
  });

  it('strips whitespace from primary and fallbacks', () => {
    const next = addRoute({}, 'test-alias', '  gemini-1.5-pro  ', ' gemini-flash , gemini-pro ');
    assert.equal(next['test-alias'].primary, 'gemini-1.5-pro');
    assert.deepEqual(next['test-alias'].fallback, ['gemini-flash', 'gemini-pro']);
  });
});

describe('Route deletion', () => {
  const routes: Routes = {
    'claude-haiku': { primary: 'gemini-flash', fallback: [] },
    'claude-sonnet': { primary: 'gemini-1.5-pro', fallback: ['gemini-flash'] },
  };

  it('removes the specified route', () => {
    const next = deleteRoute(routes, 'claude-haiku');
    assert.ok(!('claude-haiku' in next));
    assert.ok('claude-sonnet' in next);
  });

  it('does not throw when deleting nonexistent key', () => {
    const next = deleteRoute(routes, 'nonexistent');
    assert.deepEqual(Object.keys(next).sort(), ['claude-haiku', 'claude-sonnet']);
  });

  it('leaves other routes intact', () => {
    const next = deleteRoute(routes, 'claude-haiku');
    assert.equal(Object.keys(next).length, 1);
    assert.equal(next['claude-sonnet'].primary, 'gemini-1.5-pro');
  });
});

describe('JSON mode save', () => {
  it('parses valid JSON routes', () => {
    const json = JSON.stringify({
      'claude-haiku': { primary: 'gemini-1.5-flash', fallback: [] },
    });
    const parsed = saveJsonRoutes(json);
    assert.ok('claude-haiku' in parsed);
  });

  it('throws on invalid JSON', () => {
    assert.throws(() => saveJsonRoutes('not-json'), SyntaxError);
  });

  it('handles empty object', () => {
    const parsed = saveJsonRoutes('{}');
    assert.deepEqual(parsed, {});
  });

  it('round-trips routes through JSON', () => {
    const routes: Routes = {
      'claude-opus': { primary: 'gemini-1.5-pro', fallback: ['gemini-1.5-flash'] },
    };
    const json = JSON.stringify(routes, null, 2);
    const parsed = saveJsonRoutes(json);
    assert.deepEqual(parsed, routes);
  });
});

describe('Route stats computation', () => {
  const routes: Routes = {
    'claude-haiku': { primary: 'gemini-1.5-flash', fallback: [] },
    'claude-sonnet': { primary: 'gemini-1.5-pro', fallback: ['gemini-1.5-flash'] },
    'claude-opus': { primary: 'gemini-1.5-pro', fallback: ['gemini-1.5-pro-002'] },
  };

  it('counts total aliases', () => {
    assert.equal(Object.keys(routes).length, 3);
  });

  it('counts unique Gemini targets', () => {
    const uniqueTargets = new Set<string>();
    for (const cfg of Object.values(routes)) {
      uniqueTargets.add(cfg.primary);
      for (const fb of cfg.fallback) uniqueTargets.add(fb);
    }
    // gemini-1.5-flash, gemini-1.5-pro, gemini-1.5-pro-002
    assert.equal(uniqueTargets.size, 3);
  });
});
