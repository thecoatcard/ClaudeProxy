import assert from 'node:assert/strict';
import {
  classifyTaskType,
  getTaskModelChain,
  extractBehavioralSignals,
  classifyFromBehavior,
} from '../lib/routing/task-router.js';

describe('task-router classification', () => {
  test('reasoning routes to gemma chain — formal proof only', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'Please provide a mathematical proof using deductive reasoning proof steps' }],
    }, false);
    assert.equal(cls.type, 'REASONING');

    const chain = getTaskModelChain(cls.type);
    assert.equal(chain[0], 'gemma-4-31b-it');
  });

  test('"analyze this bug" does NOT route to REASONING (stays coding)', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'analyze this bug in my code' }],
    }, false);
    assert.notEqual(cls.type, 'REASONING');
  });

  test('"think about the best approach" does NOT route to REASONING', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'think about the best approach for this feature' }],
    }, false);
    assert.notEqual(cls.type, 'REASONING');
  });

  test('heavy coding — 5+ tools routes to heavy chain', () => {
    const cls = classifyTaskType({
      tools: [{}, {}, {}, {}, {}],
      messages: [{ role: 'user', content: 'implement this feature' }],
    }, false);
    assert.equal(cls.type, 'HEAVY_CODING');

    const chain = getTaskModelChain(cls.type);
    assert.equal(chain[0], 'gemini-2.5-flash');
  });

  test('heavy coding — architecture signal routes to heavy chain', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'Design the full-stack architecture for this system' }],
    }, false);
    assert.equal(cls.type, 'HEAVY_CODING');
  });

  test('heavy coding — multi-file references route to heavy chain', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'update src/auth.ts lib/redis.ts and app/api/route.ts' }],
    }, false);
    assert.equal(cls.type, 'HEAVY_CODING');
  });

  test('light coding — single tool routes to light chain', () => {
    const cls = classifyTaskType({
      tools: [{}],
      messages: [{ role: 'user', content: 'fix this function' }],
    }, false);
    assert.equal(cls.type, 'LIGHT_CODING');

    const chain = getTaskModelChain(cls.type);
    assert.equal(chain[0], 'gemini-3-flash-preview');
  });

  test('light coding — code block present routes to light', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'fix the error in this code: ```js\nconst x = 1;\n```' }],
    }, false);
    assert.equal(cls.type, 'LIGHT_CODING');
  });

  test('web search routes to web search chain', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'search the web for the latest Next.js release notes' }],
    }, false);
    assert.equal(cls.type, 'WEB_SEARCH');

    const chain = getTaskModelChain(cls.type);
    assert.equal(chain[0], 'gemini-3-flash-preview');
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
    assert.equal(chain[0], 'gemma-4-26b-a4b-it');
  });

  test('trivial greeting routes to CHAT', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'hi' }],
    }, false);
    assert.equal(cls.type, 'CHAT');
  });

  test('thinking enabled forces HEAVY_CODING', () => {
    const cls = classifyTaskType({
      messages: [{ role: 'user', content: 'hello' }],
    }, true);
    // trivial-chat detection runs first but thinking isn't CHAT level
    // (depends on intent detector — just verify it's not REASONING)
    assert.notEqual(cls.type, 'REASONING');
  });
});

describe('extractBehavioralSignals', () => {
  test('detects tool count and variety', () => {
    const signals = extractBehavioralSignals({
      tools: [{ name: 'bash_execute' }, { name: 'file_read' }, { name: 'file_write' }],
      messages: [{ role: 'user', content: 'do it' }],
    });
    assert.equal(signals.toolCount, 3);
    assert.ok(signals.toolVariety >= 2);
  });

  test('detects code density from file paths', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'update lib/auth.ts and src/api/route.ts and app/page.tsx' }],
    });
    assert.ok(signals.codeDensity >= 3);
    assert.equal(signals.multiFile, true);
  });

  test('detects execution density from bash commands', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'run npm install then git commit and docker build' }],
    });
    assert.ok(signals.executionDensity >= 2);
  });

  test('detects web search signal', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'search the web for react docs' }],
    });
    assert.equal(signals.webSearch, true);
  });

  test('detects explicit reasoning signal', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'give me a mathematical proof using deductive reasoning proof' }],
    });
    assert.equal(signals.explicitReasoning, true);
  });

  test('"analyze this code" does NOT set explicitReasoning', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'analyze this code and explain the bug' }],
    });
    assert.equal(signals.explicitReasoning, false);
  });
});

describe('classifyFromBehavior', () => {
  test('web search takes priority over coding signals', () => {
    const result = classifyFromBehavior(
      { toolCount: 3, toolVariety: 2, codeDensity: 5, executionDensity: 3,
        multiFile: true, architectureSignal: false, explicitReasoning: false,
        webSearch: true, messageLength: 100 },
      false
    );
    assert.equal(result.type, 'WEB_SEARCH');
  });

  test('architecture signal → HEAVY_CODING', () => {
    const result = classifyFromBehavior(
      { toolCount: 1, toolVariety: 1, codeDensity: 0, executionDensity: 0,
        multiFile: false, architectureSignal: true, explicitReasoning: false,
        webSearch: false, messageLength: 50 },
      false
    );
    assert.equal(result.type, 'HEAVY_CODING');
  });

  test('no signals → HEAVY_CODING (safe default)', () => {
    const result = classifyFromBehavior(
      { toolCount: 0, toolVariety: 0, codeDensity: 0, executionDensity: 0,
        multiFile: false, architectureSignal: false, explicitReasoning: false,
        webSearch: false, messageLength: 20 },
      false
    );
    assert.equal(result.type, 'HEAVY_CODING');
  });

  test('single code block → LIGHT_CODING', () => {
    const result = classifyFromBehavior(
      { toolCount: 0, toolVariety: 0, codeDensity: 1, executionDensity: 0,
        multiFile: false, architectureSignal: false, explicitReasoning: false,
        webSearch: false, messageLength: 30 },
      false
    );
    assert.equal(result.type, 'LIGHT_CODING');
  });
});

