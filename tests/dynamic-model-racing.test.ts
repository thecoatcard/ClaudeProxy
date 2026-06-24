/**
 * tests/dynamic-model-racing.test.ts
 *
 * Tests for dynamic model race config per task type.
 * Does NOT require live API keys — tests the decision logic only.
 */

import assert from 'node:assert/strict';
import { getDynamicModelRaceConfig, getModelsForRace } from '../lib/racing/model-racer';
import { getTaskModelChain } from '../lib/routing/task-router';
import type { TaskType } from '../lib/routing/task-router';

describe('getDynamicModelRaceConfig — model race config per task type', () => {
  test('racing is disabled by default', () => {
    const cfg = getDynamicModelRaceConfig('HEAVY_CODING');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.modelCount, 1);
  });

  test('CHAT → racing disabled', () => {
    const cfg = getDynamicModelRaceConfig('CHAT', false, true);
    assert.equal(cfg.enabled, false);
  });

  test('HEALTH_CHECK → racing disabled', () => {
    const cfg = getDynamicModelRaceConfig('HEALTH_CHECK', false, true);
    assert.equal(cfg.enabled, false);
  });

  test('COMPACTION → racing disabled', () => {
    const cfg = getDynamicModelRaceConfig('COMPACTION', false, true);
    assert.equal(cfg.enabled, false);
  });

  test('REASONING → racing disabled (Gemma primary — racing defeats purpose)', () => {
    const cfg = getDynamicModelRaceConfig('REASONING', false, true);
    assert.equal(cfg.enabled, false);
  });

  test('LIGHT_CODING → 2-model race', () => {
    const cfg = getDynamicModelRaceConfig('LIGHT_CODING', false, true);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.modelCount, 2);
  });

  test('WEB_SEARCH → 2-model race', () => {
    const cfg = getDynamicModelRaceConfig('WEB_SEARCH', false, true);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.modelCount, 2);
  });

  test('HEAVY_CODING → 3-model race', () => {
    const cfg = getDynamicModelRaceConfig('HEAVY_CODING', false, true);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.modelCount, 3);
  });

  test('overload flag enables 3-model race for all task types', () => {
    const taskTypes: TaskType[] = ['CHAT', 'HEALTH_CHECK', 'COMPACTION', 'LIGHT_CODING', 'REASONING', 'HEAVY_CODING', 'WEB_SEARCH'];
    for (const t of taskTypes) {
      const cfg = getDynamicModelRaceConfig(t, true, true);
      assert.equal(cfg.enabled, true, `Expected enabled=true for ${t} on overload`);
      assert.equal(cfg.modelCount, 3, `Expected modelCount=3 for ${t} on overload`);
    }
  });
});

describe('getModelsForRace — model selection from task chain', () => {
  test('HEAVY_CODING 3-model race uses first 3 from chain', () => {
    const models = getModelsForRace('HEAVY_CODING', 3);
    const chain = getTaskModelChain('HEAVY_CODING');
    assert.deepEqual(models, chain.slice(0, 3));
    assert.equal(models.length, 3);
  });

  test('LIGHT_CODING 2-model race uses first 2 from chain', () => {
    const models = getModelsForRace('LIGHT_CODING', 2);
    const chain = getTaskModelChain('LIGHT_CODING');
    assert.deepEqual(models, chain.slice(0, 2));
    assert.equal(models.length, 2);
  });

  test('REASONING 1-model does not race past primary', () => {
    const models = getModelsForRace('REASONING', 1);
    assert.equal(models[0], 'gemini-2.5-flash');
    assert.equal(models.length, 1);
  });

  test('model count capped by chain length', () => {
    // CHAT chain has 2 models — requesting 10 returns all 2
    const models = getModelsForRace('CHAT', 10);
    assert.ok(models.length <= 2);
  });

  test('models for WEB_SEARCH start with gemini-3-flash-preview', () => {
    const models = getModelsForRace('WEB_SEARCH', 2);
    assert.equal(models[0], 'gemini-3-flash-preview');
  });
});

describe('model race — all models stay within allowed pool', () => {
  const taskTypes: TaskType[] = ['CHAT', 'HEALTH_CHECK', 'COMPACTION', 'LIGHT_CODING', 'REASONING', 'HEAVY_CODING', 'WEB_SEARCH'];
  const ALLOWED = new Set([
    'gemma-4-31b-it', 'gemini-2.5-flash', 'gemma-4-26b-a4b-it',
    'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite-preview',
    'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3-flash-preview',
  ]);

  for (const taskType of taskTypes) {
    test(`${taskType} race models all in allowed pool`, () => {
      const cfg = getDynamicModelRaceConfig(taskType, true, true);
      const models = getModelsForRace(taskType, cfg.modelCount);
      for (const m of models) {
        assert.ok(ALLOWED.has(m), `${m} not in allowed pool`);
      }
    });
  }
});
