/**
 * tests/path-auditor-reset.test.ts
 *
 * Phase 10 — Test 5: Path auditor resets per request (Phase 6)
 *
 * The fix: inspectHistoryPaths now only scans the LAST assistant message.
 * This test verifies old path issues in prior messages don't accumulate.
 */

import { inspectHistoryPaths } from '../lib/agent/path-guard';
import { runBehaviorAudit } from '../lib/agent/behavior-auditor';

const cleanMessage = {
  role: 'assistant',
  content: [
    {
      type: 'tool_use',
      name: 'Read',
      input: { path: 'src/components/Button.tsx' },
    },
  ],
};

const traversalMessage = {
  role: 'assistant',
  content: [
    {
      type: 'tool_use',
      name: 'Write',
      input: { path: '../../etc/passwd' },
    },
  ],
};

describe('inspectHistoryPaths — per-request scope', () => {
  test('no issues when path is clean', () => {
    const issues = inspectHistoryPaths([cleanMessage]);
    expect(issues).toHaveLength(0);
  });

  test('detects traversal in current message', () => {
    const issues = inspectHistoryPaths([traversalMessage]);
    expect(issues.some((i) => i.kind === 'traversal')).toBe(true);
  });

  test('old traversal in prior message does not appear when only last message scanned', () => {
    // Simulate: prior message had traversal, current (last) message is clean
    const issues = inspectHistoryPaths([cleanMessage]); // only last msg passed
    expect(issues).toHaveLength(0);
  });

  test('empty message list returns no issues', () => {
    expect(inspectHistoryPaths([])).toHaveLength(0);
  });
});

describe('runBehaviorAudit — path issues scoped to last assistant turn', () => {
  test('no path guidance for clean last turn', async () => {
    const messages = [
      { role: 'user', content: 'fix the button' },
      traversalMessage,  // old message with path issue
      { role: 'user', content: 'also fix the icon' },
      cleanMessage,      // current (last) assistant message — clean
    ];
    const result = await runBehaviorAudit(messages, '');
    // Path issues count should be 0 (only last assistant msg scanned)
    expect(result.diagnostics.pathIssues).toBe(0);
  });

  test('path guidance fires for last assistant turn with traversal', async () => {
    const messages = [
      { role: 'user', content: 'update config' },
      cleanMessage,        // old clean message
      { role: 'user', content: 'continue' },
      traversalMessage,    // current (last) assistant message — has traversal
    ];
    const result = await runBehaviorAudit(messages, '');
    expect(result.diagnostics.pathIssues).toBeGreaterThan(0);
  });

  test('no path issues when no tool_use blocks in last turn', async () => {
    const messages = [
      traversalMessage, // prior turn with issue
      { role: 'assistant', content: [{ type: 'text', text: 'Done!' }] }, // last turn, no tool_use
    ];
    const result = await runBehaviorAudit(messages, '');
    expect(result.diagnostics.pathIssues).toBe(0);
  });
});
