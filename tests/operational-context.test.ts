// tests/operational-context.test.ts
// Run: npx tsx --test tests/operational-context.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultOperationalState,
  updateStateFromMessages,
  buildOperationalGuidance,
  loadOperationalState,
  saveOperationalState,
  operationalStateKey,
  type OperationalState,
  type OperationalStateStore,
} from '../lib/context/operational-state';

// In-memory store for testing
function makeStore(): OperationalStateStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
  };
}

function makeToolPair(id: string, toolName: string, input: any, resultText: string, isError = false): any[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: toolName, input }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: resultText, is_error: isError }],
    },
  ];
}

// ─── 6. Shell type persists ───────────────────────────────────────────────────

describe('shell type detection', () => {
  it('detects PowerShell from command', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'powershell -Command Get-Process' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'process list...' }] },
    ];
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.equal(state.shell_type, 'powershell');
    assert.equal(state.environment_type, 'windows');
    assert.ok(state.shell_capability.windows_native_commands_supported);
  });

  it('detects bash from Unix path in result', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls -la' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '/bin/bash: no such file' }] },
    ];
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.equal(state.shell_type, 'bash');
    assert.ok(state.shell_capability.unix_process_control_supported);
  });

  it('detects git-bash from command', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'git-bash -c ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ];
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.equal(state.shell_type, 'git-bash');
    assert.equal(state.environment_type, 'windows');
  });

  it('stays unknown when no shell signals', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/foo' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'content' }] },
    ];
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.equal(state.shell_type, 'unknown');
  });
});

// ─── 7. Artifact state persists ───────────────────────────────────────────────

describe('artifact tracking', () => {
  it('records files created by write tool', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'src/app.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'wrote 200 bytes' }] },
    ];
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.equal(state.known_artifacts['src/app.ts']?.status, 'exists');
  });

  it('records failed creates as failed_create', () => {
    const messages = makeToolPair('t1', 'write_file', { path: 'src/fail.ts' }, 'permission denied', true);
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.equal(state.known_artifacts['src/fail.ts']?.status, 'failed_create');
  });

  it('records missing files from error output', () => {
    const messages = makeToolPair('t1', 'bash', { command: 'cat src/missing.ts' }, 'No such file or directory "src/missing.ts"', true);
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.equal(state.known_artifacts['src/missing.ts']?.status, 'missing');
  });

  it('records artifact source tool name', () => {
    const messages = makeToolPair('t1', 'create_file', { path: 'README.md' }, 'created README.md');
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.equal(state.known_artifacts['README.md']?.source, 'create_file');
  });
});

// ─── 8. Failure patterns persist ─────────────────────────────────────────────

describe('failure memory', () => {
  it('records interactive CLI failures', () => {
    const messages = makeToolPair(
      't1', 'bash',
      { command: 'npx shadcn init' },
      'Error: stdin is not a tty',
      true,
    );
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.ok(state.known_failures.length > 0);
  });

  it('adds to blocked_patterns after 2 failures', () => {
    const base = defaultOperationalState('c1');
    const pairs1 = makeToolPair('t1', 'bash', { command: 'npx prisma init' }, '/dev/tty: No such device', true);
    const pairs2 = makeToolPair('t2', 'bash', { command: 'npx prisma init' }, '/dev/tty: No such device', true);
    const state1 = updateStateFromMessages(base, pairs1);
    const state2 = updateStateFromMessages(state1, pairs2);
    assert.ok(state2.blocked_patterns.includes('tty_not_available'), `blocked_patterns: ${JSON.stringify(state2.blocked_patterns)}`);
  });

  it('records permission denied failures', () => {
    const messages = makeToolPair('t1', 'bash', { command: 'chmod 700 /root/x' }, 'chmod: /root/x: Permission denied', true);
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    const rec = state.known_failures.find(f => f.pattern === 'permission_denied');
    assert.ok(rec, 'permission_denied failure should be recorded');
  });
});

// ─── 9. Background tasks persist ─────────────────────────────────────────────

describe('background task tracking', () => {
  it('detects npm run dev', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm run dev' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Starting server...' }] },
    ];
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.equal(state.active_background_tasks.length, 1);
    assert.equal(state.active_background_tasks[0].process, 'npm');
  });

  it('marks task as running on startup signal', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm run dev' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Ready in 1234ms' }] },
    ];
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    // After startup signal, status should be 'running'
    assert.equal(state.active_background_tasks[0].status, 'running');
  });

  it('marks task as failed on error result', () => {
    const base = defaultOperationalState('c1');
    // First create the task
    const m1 = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm run dev' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'EADDRINUSE: address already in use', is_error: true }] },
    ];
    const state = updateStateFromMessages(base, m1);
    const task = state.active_background_tasks[0];
    assert.equal(task?.status, 'failed');
  });

  it('does not double-add the same background task', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm run dev' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Starting...' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'bash', input: { command: 'npm run dev' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Already running?' }] },
    ];
    const state = updateStateFromMessages(defaultOperationalState('c1'), messages);
    assert.equal(state.active_background_tasks.length, 1);
  });
});

// ─── 10. Blocked retry patterns ───────────────────────────────────────────────

describe('blocked patterns', () => {
  it('guidance warns about blocked patterns', () => {
    const state: OperationalState = {
      ...defaultOperationalState('c1'),
      shell_type: 'powershell',
      environment_type: 'windows',
      shell_capability: {
        tty_supported: false,
        windows_native_commands_supported: true,
        unix_process_control_supported: false,
        interactive_stdin_supported: false,
      },
      blocked_patterns: ['interactive_cli_wizard', 'tty_not_available'],
    };
    const guidance = buildOperationalGuidance(state);
    assert.ok(guidance.includes('BLOCKED'), `guidance should mention BLOCKED: ${guidance}`);
    assert.ok(guidance.includes('interactive_cli_wizard'));
    assert.ok(guidance.includes('tty_not_available'));
  });

  it('guidance warns about Windows environment', () => {
    const state: OperationalState = {
      ...defaultOperationalState('c1'),
      shell_type: 'powershell',
      environment_type: 'windows',
      shell_capability: {
        tty_supported: false,
        windows_native_commands_supported: true,
        unix_process_control_supported: false,
        interactive_stdin_supported: false,
      },
    };
    const guidance = buildOperationalGuidance(state);
    assert.ok(guidance.includes('Windows'));
    assert.ok(guidance.includes('kill -9') || guidance.includes('Unix'));
  });

  it('returns empty string for unknown bare state', () => {
    const state = defaultOperationalState('c1');
    const guidance = buildOperationalGuidance(state);
    assert.equal(guidance, '');
  });
});

// ─── Redis persistence ────────────────────────────────────────────────────────

describe('persistence (load/save)', () => {
  it('round-trips state through store', async () => {
    const store = makeStore();
    const original: OperationalState = {
      ...defaultOperationalState('conv-42'),
      shell_type: 'bash',
      environment_type: 'unix',
      shell_capability: {
        tty_supported: true,
        windows_native_commands_supported: false,
        unix_process_control_supported: true,
        interactive_stdin_supported: true,
      },
      known_project_root: '/workspace/myapp',
      blocked_patterns: ['interactive_cli_wizard'],
    };

    await saveOperationalState(original, store);
    const loaded = await loadOperationalState('conv-42', store);

    assert.equal(loaded.shell_type, 'bash');
    assert.equal(loaded.known_project_root, '/workspace/myapp');
    assert.deepEqual(loaded.blocked_patterns, ['interactive_cli_wizard']);
  });

  it('returns default state when nothing stored', async () => {
    const store = makeStore();
    const state = await loadOperationalState('no-such-conv', store);
    assert.equal(state.shell_type, 'unknown');
    assert.equal(state.conversationId, 'no-such-conv');
  });

  it('uses correct Redis key format', () => {
    assert.equal(operationalStateKey('abc-123'), 'opstate:v2:abc-123');
  });

  it('handles corrupted JSON gracefully', async () => {
    const store = makeStore();
    store.data.set('opstate:v2:bad-conv', '{ NOT JSON }');
    const state = await loadOperationalState('bad-conv', store);
    assert.equal(state.shell_type, 'unknown'); // fell back to default
  });

  it('rejects state with wrong conversationId', async () => {
    const store = makeStore();
    await saveOperationalState({ ...defaultOperationalState('conv-A'), shell_type: 'bash' }, store);
    // Store key is for conv-A, but we ask for conv-B
    const badKey = operationalStateKey('conv-A');
    store.data.set(operationalStateKey('conv-B'), store.data.get(badKey)!);
    store.data.delete(badKey);
    const state = await loadOperationalState('conv-B', store);
    // Loaded payload has conversationId: 'conv-A' → mismatch → default returned
    assert.equal(state.conversationId, 'conv-B');
  });
});
