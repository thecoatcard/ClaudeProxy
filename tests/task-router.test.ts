import assert from 'node:assert/strict';
import { classifyTaskType, getTaskModelChain } from '../lib/routing/task-router.js';

describe('task-router classification', () => {
  test('reasoning routes to gemma chain', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'Please do contradiction analysis and root cause reasoning' }],
    }, false);
    assert.equal(cls.type, 'REASONING');

    const chain = getTaskModelChain(cls.type);
    assert.equal(chain[0], 'gemma-4-31b-it');
  });

  test('heavy coding routes to gemini flash chain', () => {
    const cls = classifyTaskType({
      tools: [{}, {}, {}],
      messages: [{ role: 'user', content: 'Generate a multi-file full-stack architecture and code' }],
    }, false);
    assert.equal(cls.type, 'HEAVY_CODING');

    const chain = getTaskModelChain(cls.type);
    assert.equal(chain[0], 'gemini-2.5-flash');
  });

  test('light tasks route to lite models', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'quick fix for key validation check' }],
    }, false);
    assert.equal(cls.type, 'LIGHT_CODING');

    const chain = getTaskModelChain(cls.type);
    assert.equal(chain[0], 'gemini-3-flash-preview');  // Fast coding: lower latency model
  });

  test('health checks route to lite chain', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'Run a health check and status ping' }],
    }, false);
    assert.equal(cls.type, 'HEALTH_CHECK');

    const chain = getTaskModelChain(cls.type);
    assert.equal(chain[0], 'gemini-2.5-flash-lite');
  });

  test('compaction routes to gemma chain', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'perform memory compaction and context compression' }],
    }, false);
    assert.equal(cls.type, 'COMPACTION');

    const chain = getTaskModelChain(cls.type);
    assert.equal(chain[0], 'gemma-4-26b-a4b-it');  // Compaction primary: smaller Gemma (efficient)
  });
});
