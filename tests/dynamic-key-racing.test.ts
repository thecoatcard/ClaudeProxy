/**
 * tests/dynamic-key-racing.test.ts
 *
 * Tests for dynamic key count selection per task type.
 * Does NOT require live API keys — tests the decision logic only.
 */

import assert from 'node:assert/strict';
import { getDynamicKeyCount } from '../lib/racing/key-racer';
import type { TaskType } from '../lib/routing/task-router';

describe('getDynamicKeyCount — key count per task type', () => {
  test('racing is disabled by default', () => {
    assert.equal(getDynamicKeyCount('HEAVY_CODING'), 1);
  });

  test('CHAT → 1 key (no racing overhead)', () => {
    assert.equal(getDynamicKeyCount('CHAT', false, true), 1);
  });

  test('HEALTH_CHECK → 1 key', () => {
    assert.equal(getDynamicKeyCount('HEALTH_CHECK', false, true), 1);
  });

  test('COMPACTION → 1 key (background task)', () => {
    assert.equal(getDynamicKeyCount('COMPACTION', false, true), 1);
  });

  test('LIGHT_CODING → 2 keys', () => {
    assert.equal(getDynamicKeyCount('LIGHT_CODING', false, true), 2);
  });

  test('REASONING → 2 keys (race on overload only)', () => {
    assert.equal(getDynamicKeyCount('REASONING', false, true), 2);
  });

  test('WEB_SEARCH → 2 keys', () => {
    assert.equal(getDynamicKeyCount('WEB_SEARCH', false, true), 2);
  });

  test('HEAVY_CODING → 3 keys (maximum latency benefit)', () => {
    assert.equal(getDynamicKeyCount('HEAVY_CODING', false, true), 3);
  });

  test('overload flag forces 3 keys for any task type', () => {
    const taskTypes: TaskType[] = ['CHAT', 'HEALTH_CHECK', 'COMPACTION', 'LIGHT_CODING', 'REASONING', 'HEAVY_CODING', 'WEB_SEARCH', 'PLANNING', 'VERIFICATION'];
    for (const t of taskTypes) {
      assert.equal(getDynamicKeyCount(t, true, true), 3, `Expected 3 for ${t} on overload`);
    }
  });

  test('unknown task type defaults to 1', () => {
    // @ts-ignore — test unknown value
    assert.equal(getDynamicKeyCount('UNKNOWN_TYPE', false, true), 1);
  });
});
