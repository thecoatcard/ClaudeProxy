// lib/tools/web-search.ts
//
// Anthropic native web_search tool compatibility layer for Gemini/Gemma backends.
//
// The Anthropic web_search server tool is declared in requests as:
//   { "type": "web_search" }
//
// Gemini has no equivalent built-in server tool. This module:
//   1. Detects web_search tool declarations in Anthropic tool arrays.
//   2. Provides the Gemini FunctionDeclaration that represents web_search.
//   3. Executes searches via pluggable provider adapters (Brave, Tavily, SerpAPI).
//   4. Normalises provider results into Anthropic web_search_result blocks.
//   5. Handles all failure paths gracefully (timeout, rate limit, empty results).
//
// Edge-runtime safe — no Node APIs, no filesystem, no shell.

export const WEB_SEARCH_TOOL_TYPE = 'web_search' as const;

// ─── Detection ────────────────────────────────────────────────────────────────

/** True when the tool object is an Anthropic native server-side web_search tool. */
export function isWebSearchTool(tool: any): boolean {
  if (!tool || typeof tool !== 'object') return false;
  return tool.type === WEB_SEARCH_TOOL_TYPE;
}

/**
 * Partition a mixed tools array into server-side web_search entries and
 * regular function tools.  Returns web search config (max_uses, domain filters)
 * merged from all web_search entries.
 */
export function partitionWebSearchTools(tools: any[]): {
  webSearchConfig: WebSearchConfig | null;
  functionTools: any[];
} {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { webSearchConfig: null, functionTools: [] };
  }

  let webSearchConfig: WebSearchConfig | null = null;
  const functionTools: any[] = [];

  for (const tool of tools) {
    if (isWebSearchTool(tool)) {
      // Merge config from all web_search declarations (last one wins per field).
      const prev: Partial<WebSearchConfig> = webSearchConfig ?? {};
      webSearchConfig = {
        maxUses: tool.max_uses ?? prev.maxUses ?? 5,
        allowedDomains: tool.allowed_domains ?? prev.allowedDomains,
        blockedDomains: tool.blocked_domains ?? prev.blockedDomains,
        userLocation: tool.user_location ?? prev.userLocation,
      };
    } else {
      functionTools.push(tool);
    }
  }

  return { webSearchConfig, functionTools };
}

// ─── Gemini interop ───────────────────────────────────────────────────────────

/**
 * Gemini FunctionDeclaration that represents the web_search capability.
 * Injected into the Gemini request when a web_search tool is present.
 */
export const WEB_SEARCH_FUNCTION_DECLARATION = {
  functionDeclarations: [
    {
      name: 'web_search',
      description:
        'Search the web for current information. Use this when you need up-to-date facts, recent events, or information that may not be in your training data.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'The search query string.',
          },
        },
        required: ['query'],
      },
    },
  ],
};

// ─── Config types ─────────────────────────────────────────────────────────────

export interface WebSearchConfig {
  maxUses: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: {
    type?: string;
    country?: string;
    region?: string;
    city?: string;
  };
}

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string;
  source?: string;
  /** Rank within results (1-based). */
  rank: number;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  provider: string;
  /** Whether the search succeeded. */
  ok: boolean;
  /** Human-readable error message when ok=false. */
  error?: string;
}

// ─── Provider adapters ────────────────────────────────────────────────────────

const SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS ?? 8000);

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function braveSearch(query: string, config?: WebSearchConfig): Promise<SearchResponse> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return { results: [], query, provider: 'brave', ok: false, error: 'BRAVE_SEARCH_API_KEY not configured' };
  }

  const params = new URLSearchParams({ q: query, count: '5', text_decorations: 'false' });
  if (config?.userLocation?.country) params.set('country', config.userLocation.country);

  try {
    const res = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      { headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey } },
      SEARCH_TIMEOUT_MS,
    );

    if (res.status === 429) {
      return { results: [], query, provider: 'brave', ok: false, error: 'Brave Search rate limited (429)' };
    }
    if (!res.ok) {
      return { results: [], query, provider: 'brave', ok: false, error: `Brave Search error: ${res.status}` };
    }

    const data = await res.json() as any;
    const rawResults: any[] = data?.web?.results ?? [];
    const results: SearchResult[] = rawResults.slice(0, 5).map((r: any, i: number) => ({
      url: String(r.url || ''),
      title: String(r.title || ''),
      snippet: String(r.description || r.extra_snippets?.[0] || ''),
      publishedDate: r.page_age ?? undefined,
      source: 'brave',
      rank: i + 1,
    }));

    // Apply domain filters
    const filtered = applyDomainFilters(results, config);
    return { results: filtered, query, provider: 'brave', ok: true };
  } catch (err: any) {
    const message = err?.name === 'AbortError' ? 'Brave Search timeout' : String(err?.message ?? err);
    return { results: [], query, provider: 'brave', ok: false, error: message };
  }
}

async function tavilySearch(query: string, config?: WebSearchConfig): Promise<SearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { results: [], query, provider: 'tavily', ok: false, error: 'TAVILY_API_KEY not configured' };
  }

  const body: any = { query, max_results: 5, search_depth: 'basic' };
  if (config?.allowedDomains?.length) body.include_domains = config.allowedDomains;
  if (config?.blockedDomains?.length) body.exclude_domains = config.blockedDomains;

  try {
    const res = await fetchWithTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      },
      SEARCH_TIMEOUT_MS,
    );

    if (res.status === 429) {
      return { results: [], query, provider: 'tavily', ok: false, error: 'Tavily rate limited (429)' };
    }
    if (!res.ok) {
      return { results: [], query, provider: 'tavily', ok: false, error: `Tavily error: ${res.status}` };
    }

    const data = await res.json() as any;
    const rawResults: any[] = data?.results ?? [];
    const results: SearchResult[] = rawResults.slice(0, 5).map((r: any, i: number) => ({
      url: String(r.url || ''),
      title: String(r.title || ''),
      snippet: String(r.content || r.snippet || ''),
      publishedDate: r.published_date ?? undefined,
      source: 'tavily',
      rank: i + 1,
    }));

    return { results, query, provider: 'tavily', ok: true };
  } catch (err: any) {
    const message = err?.name === 'AbortError' ? 'Tavily Search timeout' : String(err?.message ?? err);
    return { results: [], query, provider: 'tavily', ok: false, error: message };
  }
}

async function serpApiSearch(query: string, config?: WebSearchConfig): Promise<SearchResponse> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { results: [], query, provider: 'serpapi', ok: false, error: 'SERPAPI_KEY not configured' };
  }

  const params = new URLSearchParams({
    q: query,
    num: '5',
    api_key: apiKey,
    engine: 'google',
    output: 'json',
  });
  if (config?.userLocation?.country) params.set('gl', config.userLocation.country.toLowerCase());

  try {
    const res = await fetchWithTimeout(
      `https://serpapi.com/search?${params}`,
      { headers: { 'Accept': 'application/json' } },
      SEARCH_TIMEOUT_MS,
    );

    if (res.status === 429) {
      return { results: [], query, provider: 'serpapi', ok: false, error: 'SerpAPI rate limited (429)' };
    }
    if (!res.ok) {
      return { results: [], query, provider: 'serpapi', ok: false, error: `SerpAPI error: ${res.status}` };
    }

    const data = await res.json() as any;
    const rawResults: any[] = data?.organic_results ?? [];
    const results: SearchResult[] = rawResults.slice(0, 5).map((r: any, i: number) => ({
      url: String(r.link || ''),
      title: String(r.title || ''),
      snippet: String(r.snippet || ''),
      publishedDate: r.date ?? undefined,
      source: 'serpapi',
      rank: i + 1,
    }));

    const filtered = applyDomainFilters(results, config);
    return { results: filtered, query, provider: 'serpapi', ok: true };
  } catch (err: any) {
    const message = err?.name === 'AbortError' ? 'SerpAPI timeout' : String(err?.message ?? err);
    return { results: [], query, provider: 'serpapi', ok: false, error: message };
  }
}

function applyDomainFilters(results: SearchResult[], config?: WebSearchConfig): SearchResult[] {
  if (!config) return results;
  let filtered = results;

  if (config.allowedDomains?.length) {
    filtered = filtered.filter(r =>
      config.allowedDomains!.some(d => r.url.includes(d))
    );
  }
  if (config.blockedDomains?.length) {
    filtered = filtered.filter(r =>
      !config.blockedDomains!.some(d => r.url.includes(d))
    );
  }
  return filtered;
}

// ─── Provider selection & execution ──────────────────────────────────────────

type ProviderName = 'brave' | 'tavily' | 'serpapi';

const PROVIDER_ADAPTERS: Record<ProviderName, (query: string, config?: WebSearchConfig) => Promise<SearchResponse>> = {
  brave: braveSearch,
  tavily: tavilySearch,
  serpapi: serpApiSearch,
};

function getProviderPriority(): ProviderName[] {
  const env = (process.env.WEB_SEARCH_PROVIDER ?? '').toLowerCase().trim();
  if (env === 'brave') return ['brave', 'tavily', 'serpapi'];
  if (env === 'tavily') return ['tavily', 'brave', 'serpapi'];
  if (env === 'serpapi') return ['serpapi', 'brave', 'tavily'];
  // Auto: prefer whichever key is configured
  const priority: ProviderName[] = [];
  if (process.env.BRAVE_SEARCH_API_KEY) priority.push('brave');
  if (process.env.TAVILY_API_KEY) priority.push('tavily');
  if (process.env.SERPAPI_KEY) priority.push('serpapi');
  // Fill in remaining for fallback
  for (const p of ['brave', 'tavily', 'serpapi'] as ProviderName[]) {
    if (!priority.includes(p)) priority.push(p);
  }
  return priority;
}

/**
 * Execute a web search.  Tries providers in priority order, falling back on
 * failure.  Never throws — always returns a SearchResponse (ok may be false).
 */
export async function executeWebSearch(
  query: string,
  config?: WebSearchConfig,
): Promise<SearchResponse> {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { results: [], query: query ?? '', provider: 'none', ok: false, error: 'Empty query' };
  }

  const providers = getProviderPriority();

  for (const providerName of providers) {
    const adapter = PROVIDER_ADAPTERS[providerName];
    if (!adapter) continue;

    const result = await adapter(query.trim(), config);
    if (result.ok && result.results.length > 0) return result;
    // Try next provider on failure or empty results
    console.warn(`[web-search] provider=${providerName} failed: ${result.error ?? 'empty results'}`);
  }

  return {
    results: [],
    query,
    provider: 'none',
    ok: false,
    error: 'All search providers failed or returned empty results',
  };
}

/** Hard global timeout for the entire web search (all providers combined). */
const GLOBAL_SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_GLOBAL_TIMEOUT_MS ?? 8000);

/**
 * Execute a web search with a hard global timeout.
 *
 * If the search does not complete within GLOBAL_SEARCH_TIMEOUT_MS (default 8s),
 * returns a partial/empty SearchResponse immediately so the model call can proceed.
 * This prevents a slow/unresponsive search provider from blocking the full request.
 *
 * Partial results are allowed — if some providers responded before timeout, their
 * results are returned. If none responded, ok=false with a timeout error message.
 */
export async function executeWebSearchSafe(
  query: string,
  config?: WebSearchConfig,
): Promise<SearchResponse> {
  const timeoutPromise: Promise<SearchResponse> = new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        results: [],
        query: query ?? '',
        provider: 'timeout',
        ok: false,
        error: `Web search global timeout after ${GLOBAL_SEARCH_TIMEOUT_MS}ms — continuing without search results`,
      });
    }, GLOBAL_SEARCH_TIMEOUT_MS);
  });

  return Promise.race([executeWebSearch(query, config), timeoutPromise]);
}

// ─── Result normalisation → Anthropic tool_result format ─────────────────────

/**
 * Convert a SearchResponse into an Anthropic tool_result content block.
 * The content array uses a structured format matching Anthropic's
 * web_search_result block shape so citations are preserved.
 */
export function normalizeSearchResults(
  response: SearchResponse,
  toolUseId: string,
): {
  type: 'tool_result';
  tool_use_id: string;
  content: any[];
  is_error?: boolean;
} {
  if (!response.ok || response.results.length === 0) {
    const errorText = response.error
      ? `Web search failed: ${response.error}`
      : 'Web search returned no results.';
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [{ type: 'text', text: errorText }],
      is_error: !response.ok,
    };
  }

  // Build Anthropic web_search_result_block content items.
  const content: any[] = response.results.map(r => ({
    type: 'web_search_result',
    url: r.url,
    title: r.title,
    encrypted_content: '', // Not available from third-party providers
    page_age: r.publishedDate ?? null,
    // Embed snippet as text so the model can read it directly.
    // Anthropic's native results have full page content; we provide snippets.
    extra_metadata: {
      snippet: r.snippet,
      rank: r.rank,
      source: r.source,
    },
  }));

  // Also add a plain text summary so models that don't parse web_search_result
  // blocks still get the information.
  const textSummary = response.results.map(r =>
    `[${r.rank}] ${r.title}\n${r.url}\n${r.snippet}`
  ).join('\n\n');

  content.push({ type: 'text', text: `Search results for "${response.query}":\n\n${textSummary}` });

  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
  };
}

/**
 * Build the Gemini functionResponse part for a completed web search.
 * Used when re-submitting to Gemini after executing the search.
 */
export function buildSearchFunctionResponse(
  response: SearchResponse,
): any {
  if (!response.ok || response.results.length === 0) {
    return {
      functionResponse: {
        name: 'web_search',
        response: {
          ok: false,
          error: response.error ?? 'No results',
        },
      },
    };
  }

  const resultsJson = response.results.map(r => ({
    rank: r.rank,
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    publishedDate: r.publishedDate ?? null,
  }));

  return {
    functionResponse: {
      name: 'web_search',
      response: {
        ok: true,
        query: response.query,
        results: resultsJson,
      },
    },
  };
}
