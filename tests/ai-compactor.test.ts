import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildCompactedMarker,
  buildCompactedRangeId,
  buildStoredSummaryMessage,
  hydrateCompactedMarkers,
  loadCompactedSummary,
  normalizeSummaryBlock,
  saveCompactedSummary,
  type CompactorStore,
} from '../lib/compactor/ai-compactor';

function memoryStore(): CompactorStore {
  const map = new Map<string, string>();
  return {
    async set(key: string, value: string) {
      map.set(key, value);
    },
    async get(key: string) {
      return map.get(key) ?? null;
    },
  };
}

describe('ai compactor persistence', () => {
  it('formats summary into required compacted memory block shape', () => {
    const out = normalizeSummaryBlock('Goal: Fix translator\nPending: Add tests');
    assert.match(out, /\[COMPACTED MEMORY BLOCK\]/);
    assert.match(out, /Goal:/);
    assert.match(out, /Completed:/);
    assert.match(out, /Pending:/);
    assert.match(out, /\[\/COMPACTED MEMORY BLOCK\]/);
  });

  it('stores and reloads compacted range metadata', async () => {
    const store = memoryStore();
    await saveCompactedSummary('conv-1', '2-8-abcd', 'Goal: Ship fix', 60, store);
    const record = await loadCompactedSummary('conv-1', '2-8-abcd', store);

    assert.ok(record);
    assert.equal(record?.conversation_id, 'conv-1');
    assert.equal(record?.compacted_range, '2-8-abcd');
    assert.equal(record?.summary, 'Goal: Ship fix');
    assert.equal(typeof record?.timestamp, 'number');
  });

  it('hydrates compacted markers using stored semantic summary', async () => {
    const store = memoryStore();
    const rangeId = buildCompactedRangeId([{ role: 'user', content: 'hello' }], 1, 4);
    await saveCompactedSummary('conv-2', rangeId, 'Goal: Continue work\nCompleted: done', 60, store);

    const messages = [
      { role: 'user', content: buildCompactedMarker(rangeId) },
      { role: 'assistant', content: [{ type: 'text', text: buildCompactedMarker('missing-range') }] },
    ];

    const hydrated = await hydrateCompactedMarkers(messages, 'conv-2', store);
    const firstText = hydrated[0].content as string;
    const secondText = hydrated[1].content[0].text as string;

    assert.equal(firstText, buildStoredSummaryMessage(rangeId, 'Goal: Continue work\nCompleted: done'));
    assert.match(secondText, /missing-range/);
  });
});
