# Web Search Support Report

## Overview

The gateway now fully supports Anthropic's native `web_search` server-side tool.
When a client sends `{"type": "web_search"}` in the tools array, the gateway
translates it into a Gemini-compatible multi-turn function-calling loop against
real search providers (Brave, Tavily, or SerpAPI).

---

## Architecture

```
Client Request (Anthropic format)
  └── tools: [{type: "web_search", max_uses: 3}, {name: "bash", ...}]
        │
        ▼
lib/transformers/request.ts (partitionWebSearchTools)
  ├── webSearchConfig  ←  extracted from web_search entries
  └── functionTools   ←  non-search tools only (sent to Gemini as FunctionDeclarations)
        │
        ▼
app/api/v1/messages/route.ts  (non-streaming)
lib/transformers/stream.ts    (streaming)
  └── if (webSearchConfig) → runWithWebSearch(geminiBody, {callGemini, webSearchConfig})
        │
        ▼
lib/tools/search-executor.ts (runWithWebSearch)
  Loop up to MAX_SEARCH_TURNS (5):
    1. Inject WEB_SEARCH_FUNCTION_DECLARATION into Gemini body
    2. Call Gemini
    3. If response contains functionCall {name: "web_search"} → execute search
    4. Append model turn + functionResponse turn to history
    5. Call Gemini again with updated history
    6. If no more search calls → return final response
        │
        ▼
lib/tools/web-search.ts (executeWebSearch)
  └── Tries providers in priority order → normalizeSearchResults → Anthropic format
```

---

## Tool Detection

`lib/tools/web-search.ts` exports:

| Function | Purpose |
|----------|---------|
| `isWebSearchTool(tool)` | Returns true if `{type: "web_search"}` |
| `partitionWebSearchTools(tools)` | Splits tools into `{webSearchConfig, functionTools}` |

Web search tools are **never** forwarded to Gemini as FunctionDeclarations.
`lib/transformers/tools.ts` filters them out via `isWebSearchTool` before
sending to Gemini's `tools` array.

### Anthropic web_search tool fields supported

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"web_search"` | Required identifier |
| `max_uses` | number | Max search calls per request (default: 5) |
| `allowed_domains` | string[] | Only return results from these domains |
| `blocked_domains` | string[] | Never return results from these domains |
| `user_location` | object | Location hint for localised results |

---

## Search Providers

### Provider Selection

Priority order (first available wins):
1. `WEB_SEARCH_PROVIDER` env var (explicit override: `'brave'|'tavily'|'serpapi'`)
2. Auto-detect by which API key is present: `BRAVE_SEARCH_API_KEY` → `TAVILY_API_KEY` → `SERPAPI_KEY`

If no provider is configured, `executeWebSearch` returns `ok: false` with a
clear error — the request still completes with a graceful error message in the
search result block.

### Provider Adapters

| Provider | Env Var | Notes |
|----------|---------|-------|
| **Brave Search** | `BRAVE_SEARCH_API_KEY` | `/web/search` endpoint; rate-limit (429) detected |
| **Tavily** | `TAVILY_API_KEY` | `/search` endpoint; `search_depth: "advanced"` |
| **SerpAPI** | `SERPAPI_KEY` | `/search?engine=google`; slower but reliable fallback |

All providers:
- Use `AbortController` for timeout (default: **8000 ms**, override via `WEB_SEARCH_TIMEOUT_MS`)
- Apply `allowedDomains` / `blockedDomains` filtering after fetch
- Detect rate-limit responses (429) and return `ok: false` with `rateLimited: true`
- Are edge-runtime safe (no Node.js APIs)

---

## Result Format

Search results are returned to the model in Anthropic `tool_result` format
with two content blocks:

### 1. `web_search_result` blocks (per result)
```json
{
  "type": "web_search_result",
  "url": "https://example.com/page",
  "title": "Page Title",
  "extra_metadata": {
    "snippet": "Relevant excerpt from the page...",
    "rank": 1,
    "source": "brave"
  }
}
```

### 2. Plain text summary block
A human-readable summary for models that don't parse `web_search_result`:
```
Web search results for "query text":
1. Page Title (https://example.com/page)
   Relevant excerpt from the page...
```

### Gemini functionResponse (internal)
For the multi-turn Gemini loop, results are re-injected as:
```json
{
  "functionResponse": {
    "name": "web_search",
    "response": {
      "ok": true,
      "results": [{"url": "...", "title": "...", "snippet": "...", "rank": 1}],
      "query": "query text",
      "provider": "brave"
    }
  }
}
```

---

## Streaming Behaviour

Since Gemini's search loop requires multiple synchronous round-trips, streaming
is handled as follows:

1. If `webSearchConfig` is active, run the full search loop **non-streamingly** first.
2. If the final response contains text (no pending tool calls), emit the answer
   as synthetic SSE events (`content_block_start` → `content_block_delta` →
   `content_block_stop` → `message_delta` → `message_stop`) and return.
3. If the final response still has tool calls (e.g. non-search tools), fall
   through to the normal streaming path.

This means search-augmented responses are not streamed token-by-token but are
delivered as a single complete response after all searches complete.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_SEARCH_PROVIDER` | (auto) | Force provider: `brave`, `tavily`, `serpapi` |
| `WEB_SEARCH_TIMEOUT_MS` | `8000` | Search HTTP timeout in milliseconds |
| `BRAVE_SEARCH_API_KEY` | — | Brave Search API key |
| `TAVILY_API_KEY` | — | Tavily API key |
| `SERPAPI_KEY` | — | SerpAPI key |

---

## Files

| File | Change |
|------|--------|
| `lib/tools/web-search.ts` | **NEW** — full provider abstraction layer |
| `lib/tools/search-executor.ts` | **NEW** — multi-turn Gemini search loop |
| `lib/transformers/tools.ts` | Modified — filters `web_search` from FunctionDeclarations |
| `lib/transformers/request.ts` | Modified — partitions tools, returns `{geminiBody, webSearchConfig}` |
| `app/api/v1/messages/route.ts` | Modified — non-streaming web search path |
| `lib/transformers/stream.ts` | Modified — streaming web search pre-execution |
| `tests/web-search.test.ts` | **NEW** — 24 tests covering detection, partitioning, normalisation |
