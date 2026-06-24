# CoatCard AI Gateway — Claude Code Context

This project is an **Anthropic-compatible AI Gateway** built with Next.js 16 (App Router, Edge Runtime).
It translates Anthropic API requests into Google Gemini API calls and streams the results back in the
Anthropic SSE format. **You are talking to Gemini, not Claude.**

## Architecture

```
Client (Claude Code / SDK)
  │  POST /v1/messages  (Anthropic API format)
  ▼
Next.js Edge Route  app/api/v1/messages/route.ts
  │  auth → transformRequestToGemini → executeWithRetry → callGemini
  │         ↑ lib/transformers/request.ts                ↑ lib/gemini-adapter.ts
  │  response/stream → transformGeminiToAnthropic / transformStream
  │                    ↑ lib/transformers/response.ts / stream.ts
  ▼
Client (SSE or JSON — Anthropic format)
```

## Key Files

| File | Purpose |
|------|---------|
| `lib/transformers/request.ts` | Anthropic → Gemini request mapping (tools, thinking, tool_choice, stop_sequences) |
| `lib/transformers/response.ts` | Gemini → Anthropic non-streaming response |
| `lib/transformers/stream.ts` | Gemini SSE → Anthropic SSE (thinking blocks, tool_use, parallel tools) |
| `lib/transformers/tools.ts` | JSON Schema → Gemini FunctionDeclaration conversion |
| `lib/transformers/repair.ts` | Coerces Gemini functionCall.args to match original Anthropic input_schema |
| `lib/retry-engine.ts` | Key rotation, fallback model chain, thoughtSignature stripping, cache |
| `lib/model-router.ts` | Claude model → Gemini model mapping (overridable via Redis `models:registry`) |
| `lib/key-manager.ts` | Gemini API key pool (Redis sorted-set), lazy cooldown recovery |
| `lib/cache-manager.ts` | Gemini context caching for large prefixes |
| `app/api/v1/messages/route.ts` | Main POST handler |
| `app/api/v1/messages/count_tokens/route.ts` | Token pre-flight for Claude Code |

## Supported Anthropic Features

- ✅ Streaming (`stream: true`) with full SSE event sequence
- ✅ Non-streaming JSON responses
- ✅ Tool use / function calling (parallel tools supported)
- ✅ Extended thinking (`thinking: { type: "enabled", budget_tokens: N }`)
- ✅ Thinking blocks echoed back as `type: "thinking"` content blocks
- ✅ `tool_choice`: `auto` | `any` | `tool` | `none` → Gemini `toolConfig`
- ✅ `stop_sequences` → Gemini `stopSequences`
- ✅ `top_k`, `top_p`, `temperature`
- ✅ `max_tokens` (clamped to per-model Gemini ceiling)
- ✅ `anthropic-beta` headers silently accepted (unknown betas ignored)
- ✅ `/v1/messages/count_tokens` (auth-gated, proper `{ input_tokens }` shape)
- ✅ `interleaved-thinking-2025-05-14` beta (thinking blocks interleave with tool_use)
- ✅ `computer-use-2024-10-22` beta (tool results with image content blocks)

## Model Routing

Claude model names are mapped to Gemini models via `lib/model-router.ts`.
The mapping can be overridden at runtime by setting the Redis key `models:registry`
to a JSON object matching the `DEFAULT_MODEL_ROUTING` shape.

## Development

```bash
npm run dev      # Start Next.js dev server on port 3000
npx tsc --noEmit # Type-check without building
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `REDIS_URL` | Upstash Redis REST URL |
| `REDIS_TOKEN` | Upstash Redis REST token |
| `MASTER_API_KEY` | Admin dashboard access key |
| `MAX_RETRIES` | Max Gemini retry attempts (default: 3) |
| `KEY_COOLDOWN_429` | Seconds to cooldown a key after 429 (default: 60) |
| `KEY_COOLDOWN_503` | Seconds to cooldown a key after 503 (default: 20) |
| `DEFAULT_MODEL` | Fallback Gemini model when routing fails |
| `FALLBACK_MODEL` | Comma-separated fallback chain |
