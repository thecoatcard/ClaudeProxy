import { strict as assert } from 'node:assert';

import { transformGeminiToAnthropic } from '../lib/transformers/response';
import { stripThoughtSignatures } from '../lib/retry-engine';
import { recoverActionText } from '../lib/transformers/action-recovery';

describe('tool structure fidelity', () => {
  it('functionCall survives normal flow as tool_use', async () => {
    const geminiRes = {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              {
                functionCall: {
                  name: 'write_file',
                  args: { path: 'app.ts', content: 'export {};' },
                },
                thoughtSignature: 'sig-abc',
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    };

    const out = await transformGeminiToAnthropic(
      geminiRes,
      'claude-sonnet',
      new Map(),
      new Map([['write_file', { type: 'object', properties: { path: { type: 'string' } } }]]),
      new Map()
    );

    const tool = out.content.find((b: any) => b.type === 'tool_use');
    assert.ok(tool, 'expected tool_use block');
    assert.equal(tool.name, 'write_file');
    assert.equal(out.stop_reason, 'tool_use');
  });

  it('functionCall survives retry flow when signatures are stripped', () => {
    const body = {
      generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 } },
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'write_file', args: { path: 'a.ts' } },
              thoughtSignature: 'sig-call',
            },
            {
              thought: true,
              text: 'reasoning text',
              thoughtSignature: 'sig-thought',
            },
          ],
        },
      ],
    };

    const stripped = stripThoughtSignatures(body);
    const parts = stripped.contents[0].parts;

    assert.equal(parts[0].functionCall.name, 'write_file');
    assert.equal(parts[0].thoughtSignature, 'sig-call', 'functionCall signature must be preserved');
    assert.equal(parts[1].thoughtSignature, undefined, 'thought text signature should be stripped');
  });

  it('functionCall survives fallback-model preparation path', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'bash', args: { command: 'npm test' } },
              thoughtSignature: 'sig-fallback',
            },
          ],
        },
      ],
    };

    const prepared = stripThoughtSignatures(body);
    const call = prepared.contents[0].parts[0];

    assert.ok(call.functionCall, 'functionCall should remain present');
    assert.equal(call.functionCall.name, 'bash');
  });

  it('action-text gets recovered into tool_use', async () => {
    const geminiRes = {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              {
                text: 'Thinking... [Action: I am calling tool `write_file` with arguments: {"path":"src/app.ts","content":"ok"}]',
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };

    const out = await transformGeminiToAnthropic(
      geminiRes,
      'claude-sonnet',
      new Map(),
      new Map([['write_file', { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }]]),
      new Map([['write_file', 'write_file']])
    );

    const tool = out.content.find((b: any) => b.type === 'tool_use');
    assert.ok(tool, 'recoverable action-text should be converted to tool_use');
    assert.equal(tool.name, 'write_file');
  });

  it('recoverable action-text never leaks as visible [Action: ...] text', async () => {
    const geminiRes = {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              {
                text: 'prefix [Action: I am calling tool bash with arguments: {"command":"pwd"}] suffix',
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };

    const out = await transformGeminiToAnthropic(
      geminiRes,
      'claude-sonnet',
      new Map(),
      new Map([['bash', { type: 'object', properties: { command: { type: 'string' } } }]]),
      new Map([['bash', 'bash']])
    );

    const leaked = out.content.some((b: any) => b.type === 'text' && /\[Action:/i.test(b.text || ''));
    assert.equal(leaked, false, 'recoverable action text must not leak to client text blocks');
    const tool = out.content.find((b: any) => b.type === 'tool_use');
    assert.ok(tool);
  });

  it('action parser handles quoted names and nested JSON', () => {
    const parsed = recoverActionText(
      '[Action: I am calling tool "write_file" with arguments: {"path":"a.ts","meta":{"nested":true},"items":[1,2,3]}] trailing'
    );
    assert.ok(parsed);
    assert.equal(parsed!.toolName, 'write_file');
    assert.equal(parsed!.args.meta.nested, true);
    assert.equal(parsed!.args.items.length, 3);
  });
});
