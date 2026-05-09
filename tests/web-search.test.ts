// tests/web-search.test.ts
// Run: npx tsx --test tests/web-search.test.ts

import assert from 'node:assert/strict';
import {
  isWebSearchTool,
  partitionWebSearchTools,
  normalizeSearchResults,
  buildSearchFunctionResponse,
  WEB_SEARCH_FUNCTION_DECLARATION,
  type SearchResponse,
} from '../lib/tools/web-search';
import { transformToolsToGemini } from '../lib/transformers/tools';

// ─── 1. Tool detection ────────────────────────────────────────────────────────

describe('isWebSearchTool', () => {
  it('detects { type: "web_search" }', () => {
    assert.ok(isWebSearchTool({ type: 'web_search' }));
  });

  it('detects with extra fields', () => {
    assert.ok(isWebSearchTool({ type: 'web_search', max_uses: 3 }));
  });

  it('rejects normal function tools', () => {
    assert.equal(isWebSearchTool({ type: 'custom', name: 'my_fn', input_schema: {} }), false);
    assert.equal(isWebSearchTool({ name: 'my_fn' }), false);
  });

  it('rejects null / non-object', () => {
    assert.equal(isWebSearchTool(null), false);
    assert.equal(isWebSearchTool(undefined), false);
    assert.equal(isWebSearchTool('web_search'), false);
  });
});

// ─── 2. Partitioning ─────────────────────────────────────────────────────────

describe('partitionWebSearchTools', () => {
  it('separates web_search from function tools', () => {
    const tools = [
      { type: 'web_search', max_uses: 3 },
      { name: 'bash', type: 'custom', input_schema: {} },
      { name: 'read_file', input_schema: {} },
    ];
    const { webSearchConfig, functionTools } = partitionWebSearchTools(tools);
    assert.ok(webSearchConfig, 'webSearchConfig should be set');
    assert.equal(webSearchConfig!.maxUses, 3);
    assert.equal(functionTools.length, 2);
    assert.ok(functionTools.every(t => t.name));
  });

  it('returns null webSearchConfig for no web_search tools', () => {
    const { webSearchConfig, functionTools } = partitionWebSearchTools([{ name: 'bash' }]);
    assert.equal(webSearchConfig, null);
    assert.equal(functionTools.length, 1);
  });

  it('handles empty array', () => {
    const { webSearchConfig, functionTools } = partitionWebSearchTools([]);
    assert.equal(webSearchConfig, null);
    assert.equal(functionTools.length, 0);
  });

  it('merges max_uses from multiple web_search entries (last wins)', () => {
    const tools = [
      { type: 'web_search', max_uses: 2 },
      { type: 'web_search', max_uses: 7 },
    ];
    const { webSearchConfig } = partitionWebSearchTools(tools);
    assert.equal(webSearchConfig!.maxUses, 7);
  });

  it('applies default maxUses when not specified', () => {
    const { webSearchConfig } = partitionWebSearchTools([{ type: 'web_search' }]);
    assert.equal(webSearchConfig!.maxUses, 5);
  });

  it('captures allowed/blocked domains', () => {
    const { webSearchConfig } = partitionWebSearchTools([
      { type: 'web_search', allowed_domains: ['example.com'], blocked_domains: ['spam.com'] },
    ]);
    assert.deepEqual(webSearchConfig!.allowedDomains, ['example.com']);
    assert.deepEqual(webSearchConfig!.blockedDomains, ['spam.com']);
  });
});

// ─── 3. Gemini tool declaration ───────────────────────────────────────────────

describe('WEB_SEARCH_FUNCTION_DECLARATION', () => {
  it('has the correct shape for Gemini', () => {
    const decl = WEB_SEARCH_FUNCTION_DECLARATION;
    assert.ok(Array.isArray(decl.functionDeclarations));
    const fn = decl.functionDeclarations[0];
    assert.equal(fn.name, 'web_search');
    assert.ok(fn.description?.length > 0);
    assert.equal(fn.parameters.type, 'OBJECT');
    assert.ok(fn.parameters.properties.query);
    assert.ok(fn.parameters.required.includes('query'));
  });
});

// ─── 4. transformToolsToGemini excludes web_search tools ─────────────────────

describe('transformToolsToGemini with web_search', () => {
  it('passes through normal tools and ignores web_search', () => {
    const tools = [
      { type: 'web_search' },
      { name: 'bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
    ];
    const result = transformToolsToGemini(tools);
    // Should only contain bash, not web_search
    const names = result?.[0]?.functionDeclarations?.map((f: any) => f.name) ?? [];
    assert.ok(names.includes('bash'), 'bash should be included');
    assert.ok(!names.includes('web_search'), 'web_search should NOT be in function declarations');
  });

  it('returns undefined when only web_search tools provided', () => {
    const tools = [{ type: 'web_search' }];
    const result = transformToolsToGemini(tools);
    // Only web_search tools → nothing to declare to Gemini
    assert.equal(result, undefined);
  });
});

// ─── 5. Result normalisation ──────────────────────────────────────────────────

describe('normalizeSearchResults', () => {
  const goodResponse: SearchResponse = {
    results: [
      { url: 'https://example.com/1', title: 'Result 1', snippet: 'First result snippet', rank: 1, source: 'brave' },
      { url: 'https://example.com/2', title: 'Result 2', snippet: 'Second result snippet', rank: 2, source: 'brave' },
    ],
    query: 'test query',
    provider: 'brave',
    ok: true,
  };

  it('returns tool_result with correct tool_use_id', () => {
    const block = normalizeSearchResults(goodResponse, 'toolu_abc123');
    assert.equal(block.type, 'tool_result');
    assert.equal(block.tool_use_id, 'toolu_abc123');
    assert.ok(!block.is_error);
  });

  it('includes web_search_result content blocks with URL, title', () => {
    const block = normalizeSearchResults(goodResponse, 'toolu_abc123');
    const resultBlocks = block.content.filter((c: any) => c.type === 'web_search_result');
    assert.equal(resultBlocks.length, 2);
    assert.equal(resultBlocks[0].url, 'https://example.com/1');
    assert.equal(resultBlocks[0].title, 'Result 1');
    assert.ok(resultBlocks[0].extra_metadata?.snippet);
  });

  it('includes plain text summary block for model readability', () => {
    const block = normalizeSearchResults(goodResponse, 'toolu_abc123');
    const textBlock = block.content.find((c: any) => c.type === 'text');
    assert.ok(textBlock, 'text summary block should be present');
    assert.ok(textBlock.text.includes('test query'));
    assert.ok(textBlock.text.includes('Result 1'));
  });

  it('handles failed search response gracefully', () => {
    const failedResponse: SearchResponse = {
      results: [],
      query: 'test',
      provider: 'brave',
      ok: false,
      error: 'API key not configured',
    };
    const block = normalizeSearchResults(failedResponse, 'toolu_fail');
    assert.equal(block.is_error, true);
    assert.ok(block.content[0].text.includes('failed'));
  });

  it('handles empty results as non-error', () => {
    const emptyResponse: SearchResponse = {
      results: [],
      query: 'very obscure query',
      provider: 'tavily',
      ok: true,
    };
    const block = normalizeSearchResults(emptyResponse, 'toolu_empty');
    // No results but ok=true should still produce a non-error block with a message
    assert.ok(block.content.length > 0);
  });

  it('preserves result ranking', () => {
    const block = normalizeSearchResults(goodResponse, 'toolu_ranks');
    const resultBlocks = block.content.filter((c: any) => c.type === 'web_search_result');
    assert.equal(resultBlocks[0].extra_metadata.rank, 1);
    assert.equal(resultBlocks[1].extra_metadata.rank, 2);
  });
});

// ─── 6. Gemini function response builder ──────────────────────────────────────

describe('buildSearchFunctionResponse', () => {
  it('builds a functionResponse part for successful search', () => {
    const response: SearchResponse = {
      results: [{ url: 'https://a.com', title: 'A', snippet: 'snippet', rank: 1 }],
      query: 'hello',
      provider: 'brave',
      ok: true,
    };
    const part = buildSearchFunctionResponse(response);
    assert.equal(part.functionResponse.name, 'web_search');
    assert.ok(part.functionResponse.response.ok);
    assert.ok(Array.isArray(part.functionResponse.response.results));
  });

  it('builds an error functionResponse for failed search', () => {
    const response: SearchResponse = {
      results: [],
      query: 'fail',
      provider: 'none',
      ok: false,
      error: 'Timeout',
    };
    const part = buildSearchFunctionResponse(response);
    assert.equal(part.functionResponse.response.ok, false);
    assert.ok(part.functionResponse.response.error);
  });
});
