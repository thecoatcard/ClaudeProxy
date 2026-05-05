import { compactMessagesDetailed } from './lib/transformers/compaction';

async function runTests() {
  const messages = [
    { role: 'user', content: 'M1' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'search', input: { q: 'foo' } }
    ]},
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'Result' }
    ]},
    { role: 'assistant', content: 'M4' },
    { role: 'user', content: 'M5' }
  ];

  console.log('--- Test: Structural Safety (Tool Awareness) ---');
  // If we try to keep 3 messages (M5, M4, tool_result), 
  // the new logic should push back to keep the tool_use too.
  const result1 = await compactMessagesDetailed(messages, {
    maxMessages: 3,
    keepFirstN: 1, // M1
    keepLastN: 3   // tool_result, M4, M5
  });

  console.log('Compacted Count:', result1.messages.length);
  // It should have kept M1, tool_use, tool_result, M4, M5 (or shifted the boundary)
  console.log('Messages:', JSON.stringify(result1.messages, null, 2));

  console.log('\n--- Test: Role Alternation ---');
  const messages2 = [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A2' },
    { role: 'user', content: 'U3' }
  ];
  const result2 = await compactMessagesDetailed(messages2, {
    maxMessages: 3,
    keepFirstN: 1, // U1
    keepLastN: 1   // U3
  });
  console.log('Messages:', JSON.stringify(result2.messages, null, 2));
}

runTests().catch(console.error);
