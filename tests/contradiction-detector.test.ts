// tests/contradiction-detector.test.ts
// Tests for the contradiction loop detector.

import assert from 'node:assert/strict';
import {
  scanHistoryForContraEvents,
  detectContradictionLoops,
  detectContradiction,
} from '../lib/agent/contradiction-detector.js';

function makeMsg(toolName: string, input: Record<string, unknown>) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'x', name: toolName, input }],
  };
}

describe('scanHistoryForContraEvents', () => {
  test('detects write and delete on same file', () => {
    const messages = [
      makeMsg('create_file', { path: 'src/index.ts' }),
      makeMsg('delete_file', { path: 'src/index.ts' }),
      makeMsg('create_file', { path: 'src/index.ts' }),
    ];
    const events = scanHistoryForContraEvents(messages);
    assert.ok(events.length >= 3);
    assert.equal(events[0].operation, 'write');
    assert.equal(events[1].operation, 'delete');
    assert.equal(events[0].canonicalKey, events[1].canonicalKey);
  });

  test('detects npm install and uninstall', () => {
    const messages = [
      makeMsg('run_in_terminal', { command: 'npm install express' }),
      makeMsg('run_in_terminal', { command: 'npm uninstall express' }),
      makeMsg('run_in_terminal', { command: 'npm install express' }),
    ];
    const events = scanHistoryForContraEvents(messages);
    assert.ok(events.some(e => e.operation === 'install'));
    assert.ok(events.some(e => e.operation === 'uninstall'));
  });

  test('returns empty for non-tool messages', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    ];
    const events = scanHistoryForContraEvents(messages);
    assert.equal(events.length, 0);
  });
});

describe('detectContradictionLoops', () => {
  test('flags 2-oscillation cycle on same file', () => {
    const events = [
      { operation: 'write' as const, target: 'tailwind.config.js', canonicalKey: 'tailwind.config.js', toolName: 'create_file', messageIndex: 0 },
      { operation: 'delete' as const, target: 'tailwind.config.js', canonicalKey: 'tailwind.config.js', toolName: 'delete_file', messageIndex: 1 },
      { operation: 'write' as const, target: 'tailwind.config.js', canonicalKey: 'tailwind.config.js', toolName: 'create_file', messageIndex: 2 },
      { operation: 'delete' as const, target: 'tailwind.config.js', canonicalKey: 'tailwind.config.js', toolName: 'delete_file', messageIndex: 3 },
    ];
    const loops = detectContradictionLoops(events);
    assert.equal(loops.length, 1);
    assert.ok(loops[0].oscillations >= 2);
  });

  test('does not flag single toggle', () => {
    const events = [
      { operation: 'install' as const, target: 'lodash', canonicalKey: 'lodash', toolName: 'run_in_terminal', messageIndex: 0 },
      { operation: 'uninstall' as const, target: 'lodash', canonicalKey: 'lodash', toolName: 'run_in_terminal', messageIndex: 1 },
    ];
    const loops = detectContradictionLoops(events);
    assert.equal(loops.length, 0);
  });
});

describe('detectContradiction (integration)', () => {
  test('detects full message loop and returns guidance', () => {
    const messages = [
      makeMsg('create_file', { path: 'next.config.ts' }),
      makeMsg('delete_file', { path: 'next.config.ts' }),
      makeMsg('create_file', { path: 'next.config.ts' }),
      makeMsg('delete_file', { path: 'next.config.ts' }),
    ];
    const result = detectContradiction(messages);
    assert.equal(result.detected, true);
    assert.ok(result.loops.length > 0);
    assert.ok(result.guidance.includes('CONTRADICTION'));
    assert.ok(result.guidance.includes('web_search'));
  });

  test('no detection on non-oscillating messages', () => {
    const messages = [
      makeMsg('create_file', { path: 'a.ts' }),
      makeMsg('create_file', { path: 'b.ts' }),
      makeMsg('create_file', { path: 'c.ts' }),
    ];
    const result = detectContradiction(messages);
    assert.equal(result.detected, false);
    assert.equal(result.guidance, '');
  });
});
