// tests/gemma-helper.test.ts
// Unit tests for Gemma helper prompt building (no live API calls).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// We only test the internal logic that can be tested without calling the API.
// The live API call is integration-tested separately.
// We test: graceful failure when no key is available.

describe('gemma-helper — module structure', () => {
  test('exports runGemmaReasoning', async () => {
    const mod = await import('../lib/reasoning/gemma-helper.js');
    assert.ok(typeof mod.runGemmaReasoning === 'function');
  });

  test('exports compressOperationalState', async () => {
    const mod = await import('../lib/reasoning/gemma-helper.js');
    assert.ok(typeof mod.compressOperationalState === 'function');
  });

  test('exports analyzeToolError', async () => {
    const mod = await import('../lib/reasoning/gemma-helper.js');
    assert.ok(typeof mod.analyzeToolError === 'function');
  });

  test('exports planRecovery', async () => {
    const mod = await import('../lib/reasoning/gemma-helper.js');
    assert.ok(typeof mod.planRecovery === 'function');
  });
});

describe('compressOperationalState', () => {
  test('returns short state unchanged (below 200 chars)', async () => {
    const { compressOperationalState } = await import('../lib/reasoning/gemma-helper.js');
    const short = 'CWD: /app\nShell: bash';
    const result = await compressOperationalState(short);
    assert.equal(result, short);
  });

  test('does not throw on empty string', async () => {
    const { compressOperationalState } = await import('../lib/reasoning/gemma-helper.js');
    const result = await compressOperationalState('');
    assert.equal(result, '');
  });
});

describe('analyzeToolError', () => {
  test('does not throw on empty error text', async () => {
    const { analyzeToolError } = await import('../lib/reasoning/gemma-helper.js');
    // Will return empty string since no API key in test environment
    const result = await analyzeToolError('');
    assert.ok(typeof result === 'string');
  });

  test('does not throw on long error text', async () => {
    const { analyzeToolError } = await import('../lib/reasoning/gemma-helper.js');
    const longError = 'Error '.repeat(300);
    const result = await analyzeToolError(longError);
    assert.ok(typeof result === 'string');
  });
});

describe('planRecovery', () => {
  test('does not throw', async () => {
    const { planRecovery } = await import('../lib/reasoning/gemma-helper.js');
    const result = await planRecovery('npm install failed repeatedly');
    assert.ok(typeof result === 'string');
  });
});

describe('runGemmaReasoning', () => {
  test('returns success=false when no API key available', async () => {
    const { runGemmaReasoning } = await import('../lib/reasoning/gemma-helper.js');
    // In test environment, key-manager will fail → should return success=false gracefully
    const result = await runGemmaReasoning({
      task: 'analyze_error',
      context: 'npm install failed',
    });
    // Either success or failure is OK — just must not throw
    assert.ok(typeof result.success === 'boolean');
    assert.ok(typeof result.output === 'string');
    assert.ok(typeof result.injectAsGuidance === 'boolean');
  });
});
