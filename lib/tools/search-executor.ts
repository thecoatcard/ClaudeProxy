// lib/tools/search-executor.ts
//
// Orchestrates the multi-turn web-search loop for Gemini/Gemma backends.
//
// When the Anthropic request includes {"type": "web_search"} tools, we:
//   1. Inject a web_search FunctionDeclaration into the Gemini request.
//   2. Execute the Gemini call.
//   3. If Gemini returns a functionCall for web_search, run the search.
//   4. Inject the result as a functionResponse and repeat (up to MAX_SEARCH_TURNS).
//   5. Return the final Gemini response that contains no pending web_search calls.
//
// Edge-runtime safe — no Node APIs, no filesystem.

import {
  executeWebSearchSafe,
  buildSearchFunctionResponse,
  WEB_SEARCH_FUNCTION_DECLARATION,
  type WebSearchConfig,
} from './web-search';

const MAX_SEARCH_TURNS = 5;

export interface SearchLoopOptions {
  webSearchConfig: WebSearchConfig;
  callGemini: (body: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
}

/**
 * Run the Gemini request body through a web-search-aware loop.
 * Returns the final Gemini response JSON (parsed).
 */
export async function runWithWebSearch(
  geminiBody: any,
  options: SearchLoopOptions,
): Promise<any> {
  const { webSearchConfig, callGemini } = options;

  // Inject our web_search FunctionDeclaration.
  const bodyWithSearch = injectWebSearchTool(geminiBody);
  let currentBody = bodyWithSearch;
  let searchUses = 0;

  for (let turn = 0; turn < MAX_SEARCH_TURNS; turn++) {
    const res = await callGemini(currentBody);
    const geminiData = await res.json();

    // Extract the candidate's parts.
    const candidate = geminiData?.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];

    // Find all web_search function calls in this response.
    const searchCalls = parts.filter(
      (p: any) => p.functionCall?.name === 'web_search',
    );

    if (searchCalls.length === 0) {
      // No more searches needed — return the final response.
      return geminiData;
    }

    if (searchUses >= webSearchConfig.maxUses) {
      console.warn('[search-executor] max web_search uses reached, stopping search loop');
      return geminiData;
    }

    // Execute each search call in parallel.
    const searchResults = await Promise.all(
      searchCalls.map(async (part: any) => {
        const query = String(part.functionCall.args?.query ?? '');
        searchUses++;
        return executeWebSearchSafe(query, webSearchConfig);
      }),
    );

    // Build the next turn: append the model response and our function responses.
    const modelTurn = {
      role: 'model',
      parts,
    };
    const userParts = searchCalls.map((_, i) =>
      buildSearchFunctionResponse(searchResults[i]),
    );
    const userTurn = { role: 'user', parts: userParts };

    currentBody = {
      ...currentBody,
      contents: [
        ...(currentBody.contents ?? []),
        modelTurn,
        userTurn,
      ],
    };
  }

  // Fallback: ran out of turns — make one final call without function declarations.
  const finalBody = { ...currentBody, tools: removeWebSearchDeclaration(currentBody.tools) };
  const finalRes = await callGemini(finalBody);
  return finalRes.json();
}

function injectWebSearchTool(geminiBody: any): any {
  const existingTools: any[] = geminiBody.tools ?? [];
  // Avoid duplicates — only inject if not already present.
  const alreadyHas = existingTools.some((t: any) =>
    t.functionDeclarations?.some((f: any) => f.name === 'web_search'),
  );
  if (alreadyHas) return geminiBody;
  return {
    ...geminiBody,
    tools: [...existingTools, WEB_SEARCH_FUNCTION_DECLARATION],
  };
}

function removeWebSearchDeclaration(tools: any[] | undefined): any[] | undefined {
  if (!tools) return undefined;
  return tools
    .map((t: any) => {
      if (!t.functionDeclarations) return t;
      const filtered = t.functionDeclarations.filter((f: any) => f.name !== 'web_search');
      if (filtered.length === 0) return null;
      return { ...t, functionDeclarations: filtered };
    })
    .filter(Boolean);
}
