/**
 * tests/orchestrator-guard.test.ts
 *
 * Tests that the orchestrator guard correctly skips orchestration for trivial messages.
 */

const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  pipeline: jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue([]),
  }),
};
jest.mock('@/lib/redis', () => ({ redis: mockRedis }));

import { classifyComplexity } from '@/lib/agent/task-complexity';

function makeBody(userMessage: string, system?: string) {
  return {
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: userMessage }],
  };
}

describe('OrchestratorGuard', () => {
  test('greeting classified as TRIVIAL with orchestrator NOT required', () => {
    const result = classifyComplexity(makeBody('hi'));
    expect(result.level).toBe('TRIVIAL');
    expect(result.orchestratorRequired).toBe(false);
  });

  test('greeting with system prompt still classified as TRIVIAL', () => {
    const result = classifyComplexity(makeBody('hello', 'You are a coding assistant with many tools'));
    expect(result.level).toBe('TRIVIAL');
    expect(result.orchestratorRequired).toBe(false);
  });

  test.each(['hi', 'hello', 'hey', 'thanks', 'ok', 'yes', 'no', 'cool', 'nice'])
    ('"%s" classified as TRIVIAL, no orchestrator', (msg) => {
      const result = classifyComplexity(makeBody(msg));
      expect(result.level).toBe('TRIVIAL');
      expect(result.orchestratorRequired).toBe(false);
    });

  test('complex task does not trigger legacy gateway orchestrator by default', () => {
    const result = classifyComplexity(makeBody('Build a full-stack authentication system with API'));
    expect(result.level).not.toBe('TRIVIAL');
    expect(result.orchestratorRequired).toBe(false);
  });

  test('explicit override is recorded but does not trigger legacy gateway orchestrator by default', () => {
    const result = classifyComplexity(makeBody('switch to orchestrator'));
    expect(result.orchestratorRequired).toBe(false);
    expect(result.explicitOverride).toBe(true);
  });

  test('question does not trigger orchestrator', () => {
    const result = classifyComplexity(makeBody('What is TypeScript?'));
    // Questions hit the intent detector → TRIVIAL
    expect(result.orchestratorRequired).toBe(false);
  });

  test('no HEALTH_CHECK misclassification for greetings', () => {
    // "ping" should NOT be classified as requiring orchestrator
    const result = classifyComplexity(makeBody('ping'));
    expect(result.level).toBe('TRIVIAL');
    expect(result.orchestratorRequired).toBe(false);
  });
});
