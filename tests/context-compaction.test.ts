import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { compactMessagesDetailed } from '../lib/transformers/compaction';

function textMsg(role: 'user' | 'assistant', text: string) {
  return { role, content: [{ type: 'text', text }] };
}

function toolUse(role: 'assistant', id: string, name: string, input: any) {
  return { role, content: [{ type: 'tool_use', id, name, input }] };
}

function toolResult(role: 'user', toolUseId: string, content: string, isError = false) {
  return {
    role,
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
  };
}

async function runCompaction(messages: any[]) {
  return compactMessagesDetailed(messages, {
    maxMessages: 6,
    maxTokensApprox: 120,
    keepFirstN: 1,
    keepLastN: 2,
    summaryCharBudget: 1400,
  });
}

function joinedText(messages: any[]): string {
  return messages
    .flatMap((m: any) => {
      if (typeof m.content === 'string') return [m.content];
      if (!Array.isArray(m.content)) return [];
      return m.content.map((b: any) => (typeof b?.text === 'string' ? b.text : ''));
    })
    .join('\n');
}

describe('context compaction continuity', () => {
  it('compaction preserves unfinished tasks in summary', async () => {
    const messages = [
      textMsg('user', 'Bootstrap project context.'),
      textMsg('assistant', 'Setup done.'),
      textMsg('user', 'Task list:\n- [x] init\n- [ ] wire retries\n- [ ] add tests'),
      textMsg('assistant', 'Working on retry wiring now.'),
      textMsg('user', 'Keep moving.'),
      textMsg('assistant', 'Not finished yet.'),
      textMsg('user', 'Final request: continue from previous state'),
      textMsg('assistant', 'Ready.'),
    ];

    const out = await runCompaction(messages);
    const text = joinedText(out.messages);
    assert.ok(/Pending subtasks:/i.test(text), 'summary should carry pending subtasks');
    assert.ok(/wire retries/i.test(text), 'unfinished checklist item should survive');
  });

  it('compaction preserves failed tool history', async () => {
    const messages = [
      textMsg('user', 'start'),
      toolUse('assistant', 't1', 'write_file', { path: 'src/app.ts' }),
      toolResult('user', 't1', 'ENOENT: no such file or directory src/app.ts', true),
      textMsg('assistant', 'I will retry after creating parent dir.'),
      textMsg('user', 'continue'),
      textMsg('assistant', 'more context'),
      textMsg('user', 'continue 2'),
      textMsg('assistant', 'tail'),
    ];

    const out = await runCompaction(messages);
    const text = joinedText(out.messages);
    const hasStructuredFailure = out.messages.some(
      (m: any) => Array.isArray(m?.content) && m.content.some((b: any) => b?.type === 'tool_result' && (b.is_error === true || /ENOENT/i.test(String(b.content || ''))))
    );
    assert.ok(/Failed attempts:/i.test(text) || /ENOENT/i.test(text) || hasStructuredFailure, 'failure history should survive compaction');
  });

  it('compaction preserves active pending tool chain', async () => {
    const messages = [
      textMsg('user', 'start'),
      textMsg('assistant', 'planning'),
      toolUse('assistant', 'pending_tool', 'bash', { command: 'npm test' }),
      textMsg('user', 'other context'),
      textMsg('assistant', 'more context'),
      textMsg('user', 'tail user message'),
      textMsg('assistant', 'tail assistant message'),
    ];

    const out = await runCompaction(messages);
    const hasPendingTool = out.messages.some(
      (m: any) => Array.isArray(m?.content) && m.content.some((b: any) => b?.type === 'tool_use' && b.id === 'pending_tool')
    );
    assert.equal(hasPendingTool, true, 'pending tool_use should remain in retained history');
  });

  it('compaction summary preserves current working goal', async () => {
    const messages = [
      textMsg('user', 'initial'),
      textMsg('assistant', 'ack'),
      textMsg('user', 'Current objective: fix action leakage and preserve structured tool calls.'),
      textMsg('assistant', 'Working on parser changes.'),
      textMsg('user', 'continue'),
      textMsg('assistant', 'progress update'),
      textMsg('user', 'tail'),
      textMsg('assistant', 'tail ack'),
    ];

    const out = await runCompaction(messages);
    const text = joinedText(out.messages);
    assert.ok(/Current goal:/i.test(text) || /objective/i.test(text), 'summary should preserve objective context');
  });

  it('compaction summary preserves latest working state', async () => {
    const messages = [
      textMsg('user', 'start context'),
      textMsg('assistant', 'state 1'),
      textMsg('user', 'keep going'),
      textMsg('assistant', 'Latest state: parser updated, tests pending.'),
      textMsg('user', 'next'),
      textMsg('assistant', 'still running tests'),
      textMsg('user', 'tail user'),
      textMsg('assistant', 'tail assistant'),
    ];

    const out = await runCompaction(messages);
    const text = joinedText(out.messages);
    assert.ok(/Latest working state:/i.test(text) || /parser updated/i.test(text), 'latest state should survive in summary');
  });
});
