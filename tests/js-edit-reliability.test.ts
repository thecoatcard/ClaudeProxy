import { detectEditStagnation } from '../lib/transformers/loop-detector';
import {
  buildStructureAwarePatchGuidance,
  detectPatchStrategy,
} from '../lib/tools/structure-aware-patch';

function toolUse(id: string, name: string, input: Record<string, any> = {}) {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}

function toolResult(id: string, content: string, isError = false) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] };
}

describe('js edit reliability', () => {
  test('uses AST_NODE strategy for JS/TS files', () => {
    expect(detectPatchStrategy('/src/a.js')).toBe('AST_NODE');
    expect(detectPatchStrategy('/src/a.tsx')).toBe('AST_NODE');
  });

  test('structure guidance for JS contains node-level instructions', () => {
    const guidance = buildStructureAwarePatchGuidance('/src/a.ts', 'EXACT_MATCH_FAILURE');
    expect(guidance).toContain('JS/TS structure-aware patching');
    expect(guidance).toContain('function/node scope');
  });

  test('stagnation guidance includes structure-aware patching for JS file', () => {
    const messages = [
      toolUse('r1', 'read_file', { path: '/src/app.ts' }),
      toolResult('r1', 'function x() {}'),
      toolUse('e1', 'str_replace_based_edit_tool', {
        path: '/src/app.ts',
        old_string: 'function x() {}',
        new_string: 'function x() { return 1; }',
      }),
      toolResult('e1', 'old_string not found', true),
      toolUse('r2', 'read_file', { path: '/src/app.ts' }),
      toolResult('r2', 'function x() {}'),
      toolUse('e2', 'str_replace_based_edit_tool', {
        path: '/src/app.ts',
        old_string: 'function x() {}',
        new_string: 'function x() { return 1; }',
      }),
      toolResult('e2', 'old_string not found', true),
    ];

    const result = detectEditStagnation(messages);
    expect(result.detected).toBe(true);
    expect(result.guidance).toContain('JS/TS structure-aware patching');
  });
});
