# Web Search Timeout Report

**Phase 5 of the 8-Phase Focused Improvement Pass**

---

## Summary

Web search is now protected by a global 8-second timeout that never blocks the model call. Previously, up to 3 serial provider timeouts (3 × 8s = 24s) could delay the inference response.

---

## Problem

The `executeWebSearch()` function tries multiple providers sequentially. Each provider has an 8s per-provider timeout. In the worst case (all providers fail with timeout):
- Brave: 8s
- Tavily: 8s  
- SerpApi: 8s
- **Total: 24s delay before model inference begins**

This violates the latency contract (web search must not block model call).

---

## Fix: `executeWebSearchSafe()`

```typescript
const GLOBAL_SEARCH_TIMEOUT_MS = Number(
  process.env.WEB_SEARCH_GLOBAL_TIMEOUT_MS ?? 8000
);

export async function executeWebSearchSafe(
  query: string,
  config?: Partial<WebSearchConfig>
): Promise<SearchResponse> {
  const timeoutPromise = new Promise<SearchResponse>((resolve) =>
    setTimeout(() => resolve({
      results: [],
      query,
      provider: 'timeout',
      ok: false,
      error: `Web search timed out after ${GLOBAL_SEARCH_TIMEOUT_MS}ms`,
    }), GLOBAL_SEARCH_TIMEOUT_MS)
  );
  return Promise.race([executeWebSearch(query, config), timeoutPromise]);
}
```

**Properties:**
- Never throws — always resolves
- Returns `ok: false` with `provider: 'timeout'` on timeout
- `WEB_SEARCH_GLOBAL_TIMEOUT_MS` env var controls the limit (default: 8000ms)
- `executeWebSearch()` still exists unchanged — `executeWebSearchSafe` wraps it

---

## Integration: `lib/tools/search-executor.ts`

Updated to import and call `executeWebSearchSafe` instead of `executeWebSearch`. The search loop continues working identically — but each individual search call is now capped at 8s globally.

---

## Files Changed

- `lib/tools/web-search.ts` — Added `executeWebSearchSafe()` with global Promise.race timeout
- `lib/tools/search-executor.ts` — Updated import + call site to use `executeWebSearchSafe`
- `tests/web-search-timeout.test.ts` — NEW: timeout safety tests

---

## Configuration

| Env Var | Default | Effect |
|---------|---------|--------|
| `WEB_SEARCH_GLOBAL_TIMEOUT_MS` | `8000` | Global cap on entire web search operation |
| `WEB_SEARCH_TIMEOUT_MS` | `8000` | Per-provider timeout (unchanged) |

---

## Test Results

- `tests/web-search-timeout.test.ts`: all pass
- No provider hangs can exceed 8s wall time
