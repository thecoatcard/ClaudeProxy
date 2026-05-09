/**
 * tests/complexity-no-toolcount.test.ts
 * Verifies that tool count no longer drives complexity classification.
 */

jest.mock('../lib/agent/intent-detector', () => ({
  detectIntent: jest.fn().mockReturnValue({ intent: 'TASK', reason: 'default' }),
  extractUserMessage: jest.fn().mockReturnValue('create a REST API'),
}));

import { classifyComplexity } from '../lib/agent/task-complexity';

describe('Complexity: tool count removed', () => {
  test('20 tools does not force COMPLEX when text is trivial', () => {
    const body = {
      messages: [{ role: 'user', content: 'hello' }],
      tools: Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}` })),
    };
    // With intent mocked as TASK and no complex keywords, should be NORMAL
    const result = classifyComplexity(body);
    expect(result.level).not.toBe('COMPLEX');
    // Should not mention tool count
    expect(result.reason).not.toMatch(/tool.count/i);
  });

  test('3 tools does not force COMPLEX', () => {
    const body = {
      messages: [{ role: 'user', content: 'fix a typo' }],
      tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    };
    const result = classifyComplexity(body);
    expect(result.reason).not.toMatch(/high-tool-count/);
  });

  test('COMPLEX is still triggered by keywords (not tools)', () => {
    const { detectIntent, extractUserMessage } = require('../lib/agent/intent-detector');
    detectIntent.mockReturnValue({ intent: 'TASK', reason: 'task' });
    extractUserMessage.mockReturnValue('create a webhook integration');

    const body = {
      messages: [{ role: 'user', content: 'create a webhook integration' }],
    };
    const result = classifyComplexity(body);
    expect(result.level).toBe('COMPLEX');
    expect(result.reason).toMatch(/complex-keyword/);
  });
});
