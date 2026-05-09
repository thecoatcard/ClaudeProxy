// Tests for InteractiveCommandGuard
// Run: npx tsx --test tests/interactive-command-guard.test.ts

import assert from 'node:assert/strict';
import {
  detectInteractiveCommand,
  detectInteractiveCommandsInHistory,
  buildInteractiveCommandGuidance,
} from '../lib/agent/interactive-command-guard';

describe('detectInteractiveCommand', () => {
  it('detects shadcn init', () => {
    const d = detectInteractiveCommand('npx shadcn@latest init');
    assert.ok(d, 'should detect');
    assert.equal(d!.matchedRule, 'shadcn init');
    assert.ok(d!.recommendedFlags.includes('--yes'));
  });

  it('detects shadcn init (no version tag)', () => {
    const d = detectInteractiveCommand('npx shadcn init --skip');
    assert.ok(d);
    assert.equal(d!.matchedRule, 'shadcn init');
  });

  it('detects prisma init', () => {
    const d = detectInteractiveCommand('npx prisma init');
    assert.ok(d);
    assert.equal(d!.matchedRule, 'prisma init');
  });

  it('detects create-next-app', () => {
    const d = detectInteractiveCommand('npx create-next-app@latest my-app');
    assert.ok(d);
    assert.equal(d!.matchedRule, 'create-next-app');
  });

  it('detects firebase init', () => {
    const d = detectInteractiveCommand('firebase init');
    assert.ok(d);
  });

  it('detects create-t3-app', () => {
    const d = detectInteractiveCommand('npx create-t3-app@latest myapp');
    assert.ok(d);
    assert.ok(d!.recommendedFlags.includes('--CI'));
  });

  it('detects npm init without --yes', () => {
    const d = detectInteractiveCommand('npm init');
    assert.ok(d);
  });

  it('does NOT flag npm init --yes', () => {
    const d = detectInteractiveCommand('npm init --yes');
    assert.equal(d, null);
  });

  it('does NOT flag npm init -y', () => {
    const d = detectInteractiveCommand('npm init -y');
    assert.equal(d, null);
  });

  it('does NOT flag unrelated commands', () => {
    assert.equal(detectInteractiveCommand('npm install react'), null);
    assert.equal(detectInteractiveCommand('npx tsx --test tests/foo.test.ts'), null);
    assert.equal(detectInteractiveCommand('git commit -m "init"'), null);
  });

  it('returns null for empty input', () => {
    assert.equal(detectInteractiveCommand(''), null);
  });
});

describe('detectInteractiveCommandsInHistory', () => {
  it('detects interactive commands in tool_use blocks', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npx shadcn@latest init' } },
        ],
      },
    ];
    const detections = detectInteractiveCommandsInHistory(messages);
    assert.equal(detections.length, 1);
    assert.equal(detections[0].matchedRule, 'shadcn init');
  });

  it('finds multiple detections across turns', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm init' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't2', name: 'bash', input: { command: 'npx prisma init' } },
        ],
      },
    ];
    const detections = detectInteractiveCommandsInHistory(messages);
    assert.equal(detections.length, 2);
  });

  it('ignores non-assistant messages', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'npx shadcn init' }] },
    ];
    const detections = detectInteractiveCommandsInHistory(messages);
    assert.equal(detections.length, 0);
  });
});

describe('buildInteractiveCommandGuidance', () => {
  it('returns empty string for no detections', () => {
    const g = buildInteractiveCommandGuidance([]);
    assert.equal(g, '');
  });

  it('includes detected command in guidance', () => {
    const d = detectInteractiveCommand('npx shadcn@latest init')!;
    const g = buildInteractiveCommandGuidance([d]);
    assert.ok(g.includes('GATEWAY INTERACTIVE COMMAND GUARD'));
    assert.ok(g.includes('shadcn'));
    assert.ok(g.includes('--yes'));
  });
});
