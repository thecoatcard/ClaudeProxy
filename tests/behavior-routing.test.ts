/**
 * tests/behavior-routing.test.ts
 *
 * Tests for behavioral routing — ensures classification is driven by
 * observable signals (tool density, code density, execution density)
 * rather than keyword matching.
 */

import assert from 'node:assert/strict';
import {
  classifyTaskType,
  extractBehavioralSignals,
  classifyFromBehavior,
  getTaskModelChain,
  type BehavioralSignals,
} from '../lib/routing/task-router';

// ─── Helper: build a minimal request body ────────────────────────────────────

function makeRequest(
  text: string,
  opts: { tools?: any[]; thinking?: boolean } = {}
) {
  return {
    messages: [{ role: 'user', content: text }],
    tools: opts.tools ?? [],
  };
}

function noSignals(overrides: Partial<BehavioralSignals> = {}): BehavioralSignals {
  return {
    toolCount: 0,
    toolVariety: 0,
    codeDensity: 0,
    executionDensity: 0,
    multiFile: false,
    architectureSignal: false,
    explicitReasoning: false,
    webSearch: false,
    messageLength: 20,
    ...overrides,
  };
}

// ─── REASONING: must NOT trigger on ordinary coding/analysis ─────────────────

describe('REASONING — only formal logic/proof', () => {
  const reasoningPhrases = [
    'Give me a mathematical proof using deductive reasoning proof steps',
    'Use formal proof and inductive reasoning proof to show this',
    'Apply probabilistic reasoning and bayesian reasoning to this problem',
    'Contradiction analysis with causal inference required',
    'Perform a chain-of-thought reasoning step-by-step and bayesian reasoning',
  ];

  for (const phrase of reasoningPhrases) {
    test(`routes to REASONING: "${phrase.slice(0, 60)}"`, () => {
      const cls = classifyTaskType(makeRequest(phrase));
      assert.equal(cls.type, 'REASONING');
    });
  }

  const notReasoningPhrases = [
    'analyze this bug',
    'think about the best approach',
    'explain why this error occurs',
    'review my code',
    'what do you think about this design',
    'can you reason about the tradeoffs',
    'give me your reasoning',
    'root cause of the bug',
    'step by step instructions',
  ];

  for (const phrase of notReasoningPhrases) {
    test(`does NOT route to REASONING: "${phrase}"`, () => {
      const cls = classifyTaskType(makeRequest(phrase));
      assert.notEqual(cls.type, 'REASONING', `"${phrase}" incorrectly classified as REASONING`);
    });
  }
});

// ─── HEAVY_CODING behavioral triggers ────────────────────────────────────────

describe('HEAVY_CODING — behavioral signals', () => {
  test('5+ tools triggers HEAVY_CODING', () => {
    const cls = classifyFromBehavior(noSignals({ toolCount: 5, toolVariety: 3 }), false);
    assert.equal(cls.type, 'HEAVY_CODING');
    assert.equal(cls.reason, 'high-tool-count');
  });

  test('architectureSignal triggers HEAVY_CODING', () => {
    const cls = classifyFromBehavior(noSignals({ architectureSignal: true }), false);
    assert.equal(cls.type, 'HEAVY_CODING');
    assert.equal(cls.reason, 'architecture-signal');
  });

  test('multi-file triggers HEAVY_CODING', () => {
    const cls = classifyFromBehavior(noSignals({ multiFile: true }), false);
    assert.equal(cls.type, 'HEAVY_CODING');
    assert.equal(cls.reason, 'multi-file-signal');
  });

  test('execution density >= 4 triggers HEAVY_CODING', () => {
    const cls = classifyFromBehavior(noSignals({ executionDensity: 4 }), false);
    assert.equal(cls.type, 'HEAVY_CODING');
  });

  test('2 tools + 3 code density triggers HEAVY_CODING', () => {
    const cls = classifyFromBehavior(noSignals({ toolCount: 2, codeDensity: 3 }), false);
    assert.equal(cls.type, 'HEAVY_CODING');
  });

  test('thinking enabled forces HEAVY_CODING even with no other signals', () => {
    const cls = classifyFromBehavior(noSignals(), true);
    assert.equal(cls.type, 'HEAVY_CODING');
    assert.equal(cls.reason, 'thinking-enabled');
  });

  test('request with 3 distinct file paths → HEAVY_CODING', () => {
    const cls = classifyTaskType(makeRequest('update src/auth.ts and lib/redis.ts and app/api/route.ts'));
    assert.equal(cls.type, 'HEAVY_CODING');
  });

  test('architecture keyword in request → HEAVY_CODING', () => {
    const cls = classifyTaskType(makeRequest('design the database schema and full-stack architecture'));
    assert.equal(cls.type, 'HEAVY_CODING');
  });
});

// ─── LIGHT_CODING behavioral triggers ────────────────────────────────────────

describe('LIGHT_CODING — behavioral signals', () => {
  test('1 tool → LIGHT_CODING', () => {
    const cls = classifyFromBehavior(noSignals({ toolCount: 1, toolVariety: 1 }), false);
    assert.equal(cls.type, 'LIGHT_CODING');
  });

  test('code density 1 → LIGHT_CODING', () => {
    const cls = classifyFromBehavior(noSignals({ codeDensity: 1 }), false);
    assert.equal(cls.type, 'LIGHT_CODING');
  });

  test('execution density 1 → LIGHT_CODING', () => {
    const cls = classifyFromBehavior(noSignals({ executionDensity: 1 }), false);
    assert.equal(cls.type, 'LIGHT_CODING');
  });

  test('request with a code block → LIGHT_CODING', () => {
    const cls = classifyTaskType(makeRequest('fix this: ```js\nconst x = 1;\n```'));
    assert.equal(cls.type, 'LIGHT_CODING');
  });

  test('request referencing a .ts file → LIGHT_CODING', () => {
    const cls = classifyTaskType(makeRequest('there is a bug in auth.ts'));
    assert.equal(cls.type, 'LIGHT_CODING');
  });

  test('LIGHT_CODING routes to gemini-3.5-flash', () => {
    const chain = getTaskModelChain('LIGHT_CODING');
    assert.equal(chain[0], 'gemini-3.5-flash');
  });
});

// ─── WEB_SEARCH ──────────────────────────────────────────────────────────────

describe('WEB_SEARCH routing', () => {
  const webSearchPhrases = [
    'search the web for Next.js release notes',
    'search the internet for this library',
    'look up online how to configure webpack',
    'find on the web the latest prisma docs',
    'google for the best react state library',
    'browse for open source alternatives',
    'web search for typescript generics tutorial',
  ];

  for (const phrase of webSearchPhrases) {
    test(`routes to WEB_SEARCH: "${phrase}"`, () => {
      const cls = classifyTaskType(makeRequest(phrase));
      assert.equal(cls.type, 'WEB_SEARCH');
    });
  }

  test('WEB_SEARCH takes priority over heavy coding signals', () => {
    const cls = classifyFromBehavior(
      noSignals({ toolCount: 10, multiFile: true, webSearch: true }),
      false
    );
    assert.equal(cls.type, 'WEB_SEARCH');
  });

  test('WEB_SEARCH routes to gemini-2.5-flash-lite', () => {
    const chain = getTaskModelChain('WEB_SEARCH');
    assert.equal(chain[0], 'gemini-2.5-flash-lite');
  });
});

// ─── Signal extraction accuracy ───────────────────────────────────────────────

describe('extractBehavioralSignals accuracy', () => {
  test('detects tool count and variety', () => {
    const signals = extractBehavioralSignals({
      tools: [
        { name: 'bash_execute' },
        { name: 'file_read' },
        { name: 'file_write' },
        { name: 'bash_run' },
      ],
      messages: [{ role: 'user', content: 'run it' }],
    });
    assert.equal(signals.toolCount, 4);
    // bash and file are two distinct prefixes → variety >= 2
    assert.ok(signals.toolVariety >= 2);
  });

  test('counts file path extensions as code density', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'look at file.ts and module.js and style.css' }],
    });
    assert.ok(signals.codeDensity >= 3);
  });

  test('detects multi-file threshold at 3 unique files', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'edit src/a.ts src/b.ts src/c.ts' }],
    });
    assert.equal(signals.multiFile, true);
  });

  test('2 files does NOT trigger multiFile', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'edit a.ts and b.ts' }],
    });
    assert.equal(signals.multiFile, false);
  });

  test('npm/git/docker count as execution density', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'run npm install and git commit and docker build' }],
    });
    assert.ok(signals.executionDensity >= 2);
  });

  test('architecture keywords set architectureSignal', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'design the api architecture' }],
    });
    assert.equal(signals.architectureSignal, true);
  });

  test('plain chat sets no signals', () => {
    const signals = extractBehavioralSignals({
      messages: [{ role: 'user', content: 'what time is it' }],
    });
    assert.equal(signals.toolCount, 0);
    assert.equal(signals.codeDensity, 0);
    assert.equal(signals.executionDensity, 0);
    assert.equal(signals.multiFile, false);
    assert.equal(signals.architectureSignal, false);
    assert.equal(signals.explicitReasoning, false);
    assert.equal(signals.webSearch, false);
  });
});
