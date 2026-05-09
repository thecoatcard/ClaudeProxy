/**
 * tests/trivial-routing.test.ts
 *
 * Tests that trivial chat messages route to lite models and skip orchestrator.
 */

import { classifyTaskType, getTaskModelChain } from '@/lib/routing/task-router';

function makeBody(userMessage: string) {
  return {
    messages: [{ role: 'user', content: userMessage }],
  };
}

describe('Trivial Routing', () => {
  test('greeting routes to CHAT type', () => {
    const cls = classifyTaskType(makeBody('hi'));
    expect(cls.type).toBe('CHAT');
  });

  test.each(['hi', 'hello', 'hey', 'thanks', 'ok', 'cool', 'yes', 'no'])
    ('"%s" routes to CHAT', (msg) => {
      const cls = classifyTaskType(makeBody(msg));
      expect(cls.type).toBe('CHAT');
    });

  test('CHAT routes to lite models', () => {
    const chain = getTaskModelChain('CHAT');
    expect(chain[0]).toBe('gemini-2.5-flash-lite');
    expect(chain).not.toContain('gemini-2.5-flash');
    expect(chain).not.toContain('gemma-4-31b-it');
  });

  test('health check only triggers on explicit health keywords', () => {
    // Explicit health check
    const healthCls = classifyTaskType(makeBody('check health of the gateway'));
    expect(healthCls.type).toBe('HEALTH_CHECK');

    // Greeting "ping" should NOT be health check
    const pingCls = classifyTaskType(makeBody('ping'));
    expect(pingCls.type).toBe('CHAT');

    // "status" alone should NOT be health check
    const statusCls = classifyTaskType(makeBody('status'));
    expect(statusCls.type).toBe('CHAT');
  });

  test('actual work request does not route to CHAT', () => {
    const cls = classifyTaskType(makeBody('Build a REST API with authentication and database'));
    expect(cls.type).not.toBe('CHAT');
  });

  test('question defaults to heavy coding (not chat)', () => {
    // Questions with code implications still default to heavy coding
    const cls = classifyTaskType(makeBody('Refactor the authentication module'));
    expect(cls.type).toBe('HEAVY_CODING');
  });
});
