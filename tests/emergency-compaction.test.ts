import {
  applyCanonicalEmergencyState,
  loadEmergencyCompactionState,
  performEmergencyCompaction,
} from '../lib/context/emergency-compactor';

function createStore() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

function makeGeminiBody(count: number) {
  return {
    contents: Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `turn ${index} :: ${'x'.repeat(80)}` }],
    })),
    generationConfig: { maxOutputTokens: 4096 },
  };
}

function makeAnthropicMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `message ${index}` }],
  }));
}

describe('emergency compactor', () => {
  test('overload triggers compaction', async () => {
    const store = createStore();
    const body = makeGeminiBody(20);
    const result = await performEmergencyCompaction(
      body,
      { conversationId: 'conv-1', summaryKey: 'summary-1', requestId: 'req-1' },
      { store, summarizeMiddle: async () => '[EMERGENCY COMPACTED CONTEXT]\nGoal: Continue\nLatestTurns: keep latest\nActiveTaskChain: fix gateway\nPendingTasks: retry smaller\nToolState: pending\nArtifacts: src/app.ts\nFailures: overloaded_error\nOperationalMemory: preserve continuity\n[/EMERGENCY COMPACTED CONTEXT]' },
    );

    expect(result.compacted).toBe(true);
    expect(result.compactionCount).toBe(1);
    expect(result.compactedContents).toBeLessThan(result.originalContents);
    expect(result.reducedChars).toBeGreaterThan(0);
  });

  test('active request rewritten with compacted summary block', async () => {
    const store = createStore();
    const body = makeGeminiBody(18);
    const result = await performEmergencyCompaction(
      body,
      { conversationId: 'conv-2', summaryKey: 'summary-2' },
      { store, summarizeMiddle: async () => '[EMERGENCY COMPACTED CONTEXT]\nGoal: Continue\nLatestTurns: latest kept\nActiveTaskChain: continue task\nPendingTasks: tests pending\nToolState: bash waiting\nArtifacts: docs/README.md\nFailures: none\nOperationalMemory: keep state\n[/EMERGENCY COMPACTED CONTEXT]' },
    );

    const summaryEntry = result.body.contents.find((entry: any) =>
      Array.isArray(entry?.parts) && entry.parts.some((part: any) => typeof part?.text === 'string' && part.text.includes('[EMERGENCY COMPACTED CONTEXT]')),
    );

    expect(summaryEntry).toBeTruthy();
    expect(result.body.contents[result.body.contents.length - 1].role).toBe('user');
  });

  test('future requests use canonical compacted state', async () => {
    const store = createStore();
    await performEmergencyCompaction(
      makeGeminiBody(20),
      { conversationId: 'conv-3', summaryKey: 'summary-3' },
      { store, summarizeMiddle: async () => '[EMERGENCY COMPACTED CONTEXT]\nGoal: Continue\nLatestTurns: latest kept\nActiveTaskChain: continue task\nPendingTasks: open\nToolState: active\nArtifacts: src/app.ts\nFailures: overloaded_error\nOperationalMemory: keep continuity\n[/EMERGENCY COMPACTED CONTEXT]' },
    );

    const state = await loadEmergencyCompactionState('conv-3', store);
    const rewritten = applyCanonicalEmergencyState(makeAnthropicMessages(20), state);

    expect(rewritten.length).toBeLessThan(20);
    expect(JSON.stringify(rewritten)).toContain('[EMERGENCY COMPACTED CONTEXT]');
  });

  test('second overload triggers second compaction', async () => {
    const store = createStore();
    const first = await performEmergencyCompaction(
      makeGeminiBody(20),
      { conversationId: 'conv-4', summaryKey: 'summary-4' },
      { store, summarizeMiddle: async () => '[EMERGENCY COMPACTED CONTEXT]\nGoal: first\nLatestTurns: keep\nActiveTaskChain: chain\nPendingTasks: pending\nToolState: state\nArtifacts: a.ts\nFailures: overload\nOperationalMemory: keep\n[/EMERGENCY COMPACTED CONTEXT]' },
    );
    const second = await performEmergencyCompaction(
      first.body,
      { conversationId: 'conv-4', summaryKey: 'summary-4' },
      { store, summarizeMiddle: async () => '[EMERGENCY COMPACTED CONTEXT]\nGoal: second\nLatestTurns: keep tighter\nActiveTaskChain: chain\nPendingTasks: pending\nToolState: reduced\nArtifacts: a.ts\nFailures: overload again\nOperationalMemory: keep\n[/EMERGENCY COMPACTED CONTEXT]' },
    );

    expect(second.compacted).toBe(true);
    expect(second.compactionCount).toBe(2);
    expect(second.body.contents.length).toBeLessThan(first.body.contents.length);
  });

  test('third overload hard falls back without more compaction', async () => {
    const store = createStore();
    const first = await performEmergencyCompaction(
      makeGeminiBody(20),
      { conversationId: 'conv-5', summaryKey: 'summary-5' },
      { store, summarizeMiddle: async () => '[EMERGENCY COMPACTED CONTEXT]\nGoal: one\nLatestTurns: keep\nActiveTaskChain: chain\nPendingTasks: pending\nToolState: state\nArtifacts: a.ts\nFailures: overload\nOperationalMemory: keep\n[/EMERGENCY COMPACTED CONTEXT]' },
    );
    const second = await performEmergencyCompaction(
      first.body,
      { conversationId: 'conv-5', summaryKey: 'summary-5' },
      { store, summarizeMiddle: async () => '[EMERGENCY COMPACTED CONTEXT]\nGoal: two\nLatestTurns: keep\nActiveTaskChain: chain\nPendingTasks: pending\nToolState: state\nArtifacts: a.ts\nFailures: overload\nOperationalMemory: keep\n[/EMERGENCY COMPACTED CONTEXT]' },
    );
    const third = await performEmergencyCompaction(
      second.body,
      { conversationId: 'conv-5', summaryKey: 'summary-5' },
      { store, summarizeMiddle: async () => null },
    );

    expect(third.compacted).toBe(false);
    expect(third.hardFallback).toBe(true);
    expect(third.compactionCount).toBe(2);
  });

  test('task continuity is preserved in retained tail', async () => {
    const store = createStore();
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'start' }] },
        { role: 'model', parts: [{ text: 'ack' }] },
        { role: 'user', parts: [{ text: 'old context 1' }] },
        { role: 'model', parts: [{ text: 'old context 2' }] },
        { role: 'user', parts: [{ text: 'pending task: update retry-engine.ts' }] },
        { role: 'model', parts: [{ text: 'working on emergency compaction now' }] },
        { role: 'user', parts: [{ text: 'latest tool state: bash test still pending' }] },
        { role: 'model', parts: [{ text: 'latest failure: overloaded_error on gemini-2.5-flash' }] },
      ],
    };

    const result = await performEmergencyCompaction(
      body,
      { conversationId: 'conv-6', summaryKey: 'summary-6' },
      { store, summarizeMiddle: async () => '[EMERGENCY COMPACTED CONTEXT]\nGoal: finish overload recovery\nLatestTurns: latest retained below\nActiveTaskChain: update retry-engine and tests\nPendingTasks: run jest\nToolState: bash pending\nArtifacts: lib/retry-engine.ts\nFailures: overloaded_error\nOperationalMemory: do not restart finished work\n[/EMERGENCY COMPACTED CONTEXT]' },
    );

    const serialized = JSON.stringify(result.body.contents);
    expect(serialized).toContain('latest tool state: bash test still pending');
    expect(serialized).toContain('latest failure: overloaded_error on gemini-2.5-flash');
    expect(serialized).toContain('update retry-engine and tests');
  });
});