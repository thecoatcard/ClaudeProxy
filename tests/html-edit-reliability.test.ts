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

describe('html edit reliability', () => {
  test('uses DOM_SELECTOR strategy for HTML files', () => {
    expect(detectPatchStrategy('/public/index.html')).toBe('DOM_SELECTOR');
  });

  test('html guidance enforces id/class selector patching', () => {
    const guidance = buildStructureAwarePatchGuidance('/public/index.html', 'NO_MATCH_FOUND');
    expect(guidance).toContain('HTML specialization');
    expect(guidance).toContain('id/class');
  });

  test('stagnation guidance includes HTML selector guidance', () => {
    const messages = [
      toolUse('r1', 'read_file', { path: '/public/index.html' }),
      toolResult('r1', '<div id="root"></div>'),
      toolUse('e1', 'str_replace_based_edit_tool', {
        path: '/public/index.html',
        old_string: '<div id="root"></div>',
        new_string: '<div id="root" class="app"></div>',
      }),
      toolResult('e1', 'no match found for old_str', true),
      toolUse('r2', 'read_file', { path: '/public/index.html' }),
      toolResult('r2', '<div id="root"></div>'),
      toolUse('e2', 'str_replace_based_edit_tool', {
        path: '/public/index.html',
        old_string: '<div id="root"></div>',
        new_string: '<div id="root" class="app"></div>',
      }),
      toolResult('e2', 'no match found for old_str', true),
    ];

    const result = detectEditStagnation(messages);
    expect(result.detected).toBe(true);
    expect(result.guidance).toContain('HTML specialization');
    expect(result.guidance).toContain('selector');
  });
});
