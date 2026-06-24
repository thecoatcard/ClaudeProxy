/**
 * tests/tool-loop-detector.test.ts
 *
 * Phase 9 tests — stagnation detection (Phase 1):
 *   - detectEditStagnation: READ_EDIT_LOOP pattern
 *   - detectEditStagnation: REPEATED_EDIT_FAIL pattern
 *   - Phase 7 loop breaker (failure count >= 3)
 *   - Phase 8 CRLF normalization in loop signatures
 *   - detectFailureLoop: existing generic loop detection (regression)
 */

import { detectEditStagnation } from '../lib/transformers/loop-detector';
import { detectFailureLoop } from '../lib/transformers/loop-detector';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toolUse(id: string, name: string, input: Record<string, any> = {}) {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}

function toolResult(id: string, content: string, isError = false) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] };
}

function editFail(id: string, file: string, oldStr = 'x', error = 'old_string not found in file') {
  return [
    toolUse(id, 'str_replace_based_edit_tool', { path: file, old_string: oldStr, new_string: 'y' }),
    toolResult(id, error, true),
  ];
}

function readFile(id: string, file: string) {
  return [
    toolUse(id, 'read_file', { path: file }),
    toolResult(id, `// content of ${file}`, false),
  ];
}

// ── detectEditStagnation — READ_EDIT_LOOP ─────────────────────────────────────

describe('detectEditStagnation — READ_EDIT_LOOP', () => {
  test('not detected when fewer than 2 edit failures', () => {
    const messages = [
      ...readFile('r1', '/src/a.ts'),
      ...editFail('e1', '/src/a.ts'),
    ];
    const r = detectEditStagnation(messages);
    // Only 1 failure after 1 read — not enough to fire
    expect(r.detected).toBe(false);
  });

  test('detected: Read → Edit fail → Read → Edit fail', () => {
    const messages = [
      ...readFile('r1', '/src/a.ts'),
      ...editFail('e1', '/src/a.ts'),
      ...readFile('r2', '/src/a.ts'),
      ...editFail('e2', '/src/a.ts'),
    ];
    const r = detectEditStagnation(messages);
    expect(r.detected).toBe(true);
    expect(r.stagnationType).toBe('READ_EDIT_LOOP');
  });

  test('diagnostics include file path and failure count', () => {
    const messages = [
      ...readFile('r1', '/src/a.ts'),
      ...editFail('e1', '/src/a.ts'),
      ...readFile('r2', '/src/a.ts'),
      ...editFail('e2', '/src/a.ts'),
    ];
    const r = detectEditStagnation(messages);
    expect(r.diagnostics?.filePath).toBe('/src/a.ts');
    expect(r.diagnostics?.failureCount).toBeGreaterThanOrEqual(2);
  });

  test('guidance contains TOOL_LOOP_STAGNATION marker', () => {
    const messages = [
      ...readFile('r1', '/src/a.ts'),
      ...editFail('e1', '/src/a.ts'),
      ...readFile('r2', '/src/a.ts'),
      ...editFail('e2', '/src/a.ts'),
    ];
    const r = detectEditStagnation(messages);
    expect(r.guidance).toContain('TOOL_LOOP_STAGNATION');
  });

  test('guidance classifies failure type', () => {
    const messages = [
      ...readFile('r1', '/src/a.ts'),
      ...editFail('e1', '/src/a.ts', 'x', 'old_string not found in file'),
      ...readFile('r2', '/src/a.ts'),
      ...editFail('e2', '/src/a.ts', 'x', 'old_string not found in file'),
    ];
    const r = detectEditStagnation(messages);
    expect(r.guidance).toContain('EXACT_MATCH_FAILURE');
  });

  test('not triggered for different files (each file fails only once)', () => {
    const messages = [
      ...readFile('r1', '/src/a.ts'),
      ...editFail('e1', '/src/a.ts'),
      ...readFile('r2', '/src/b.ts'),
      ...editFail('e2', '/src/b.ts'),
    ];
    const r = detectEditStagnation(messages);
    // Each file has only 1 failure — below threshold
    expect(r.detected).toBe(false);
  });

  test('Windows path (backslash) treated same as POSIX (Phase 8)', () => {
    const messages = [
      ...readFile('r1', 'C:\\src\\a.ts'),
      ...editFail('e1', 'C:\\src\\a.ts'),
      ...readFile('r2', 'C:\\src\\a.ts'),
      ...editFail('e2', 'C:\\src\\a.ts'),
    ];
    const r = detectEditStagnation(messages);
    expect(r.detected).toBe(true);
    expect(r.stagnationType).toBe('READ_EDIT_LOOP');
  });
});

// ── detectEditStagnation — REPEATED_EDIT_FAIL ─────────────────────────────────

describe('detectEditStagnation — REPEATED_EDIT_FAIL', () => {
  test('detected: two consecutive edit failures without read', () => {
    const messages = [
      ...editFail('e1', '/src/b.ts'),
      ...editFail('e2', '/src/b.ts'),
    ];
    const r = detectEditStagnation(messages);
    expect(r.detected).toBe(true);
    expect(r.stagnationType).toBe('REPEATED_EDIT_FAIL');
  });

  test('not detected: single edit failure', () => {
    const messages = [...editFail('e1', '/src/b.ts')];
    const r = detectEditStagnation(messages);
    expect(r.detected).toBe(false);
  });

  test('guidance contains TOOL_LOOP_STAGNATION marker', () => {
    const messages = [
      ...editFail('e1', '/src/b.ts'),
      ...editFail('e2', '/src/b.ts'),
    ];
    const r = detectEditStagnation(messages);
    expect(r.guidance).toContain('TOOL_LOOP_STAGNATION');
  });

  test('diagnostics failureCount is 2', () => {
    const messages = [
      ...editFail('e1', '/src/b.ts'),
      ...editFail('e2', '/src/b.ts'),
    ];
    const r = detectEditStagnation(messages);
    expect(r.diagnostics?.failureCount).toBe(2);
  });

  test('consecutive failures on different files — not detected', () => {
    const messages = [
      ...editFail('e1', '/src/a.ts'),
      ...editFail('e2', '/src/b.ts'),
    ];
    const r = detectEditStagnation(messages);
    // Different files; no single file has 2 consecutive failures
    expect(r.detected).toBe(false);
  });
});

// ── Phase 7 — Loop breaker ────────────────────────────────────────────────────

describe('detectEditStagnation — Phase 7 loop breaker escalation', () => {
  test('3+ failures produces ESCALATE guidance in results', () => {
    const messages = [
      ...readFile('r1', '/src/c.ts'),
      ...editFail('e1', '/src/c.ts'),
      ...readFile('r2', '/src/c.ts'),
      ...editFail('e2', '/src/c.ts'),
      ...readFile('r3', '/src/c.ts'),
      ...editFail('e3', '/src/c.ts'),
    ];
    const r = detectEditStagnation(messages);
    expect(r.detected).toBe(true);
    expect(r.diagnostics?.failureCount).toBeGreaterThanOrEqual(3);
    // ESCALATE step in guidance means loop-breaker fired
    expect(r.guidance).toContain('MANDATORY');
  });
});

// ── Phase 8 — CRLF normalization ─────────────────────────────────────────────

describe('detectEditStagnation — Phase 8 CRLF normalization', () => {
  test('CRLF error text still classified correctly', () => {
    const messages = [
      ...readFile('r1', '/src/d.ts'),
      toolUse('e1', 'str_replace_based_edit_tool', { path: '/src/d.ts', old_string: 'x', new_string: 'y' }),
      toolResult('e1', 'old_string not found\r\nin the file\r\n', true),
      ...readFile('r2', '/src/d.ts'),
      toolUse('e2', 'str_replace_based_edit_tool', { path: '/src/d.ts', old_string: 'x', new_string: 'y' }),
      toolResult('e2', 'old_string not found\r\nin the file\r\n', true),
    ];
    const r = detectEditStagnation(messages);
    expect(r.detected).toBe(true);
    expect(r.diagnostics?.lastFailureType).toBe('EXACT_MATCH_FAILURE');
  });
});

// ── detectFailureLoop — regression tests ─────────────────────────────────────

describe('detectFailureLoop — regression (generic loop detection)', () => {
  test('no loop for empty messages', () => {
    const r = detectFailureLoop([]);
    expect(r.detected).toBe(false);
  });

  test('no loop for single tool call', () => {
    const messages = [...editFail('e1', '/src/a.ts')];
    const r = detectFailureLoop(messages);
    expect(r.detected).toBe(false);
  });

  test('loop detected for 3 identical bash failures', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'bash', input: { command: 'npm test' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'Error: command not found', is_error: true }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b2', name: 'bash', input: { command: 'npm test' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b2', content: 'Error: command not found', is_error: true }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b3', name: 'bash', input: { command: 'npm test' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b3', content: 'Error: command not found', is_error: true }] },
    ];
    const r = detectFailureLoop(messages);
    expect(r.detected).toBe(true);
    expect(r.diagnostics?.toolName).toBe('bash');
  });
});
