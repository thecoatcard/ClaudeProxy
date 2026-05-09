# Compatibility Report

**Date:** 2026-05-10  
**Compatibility target:** Claude Code (Anthropic SDK)

---

## Anthropic API Compatibility

### Messages API (`POST /api/v1/messages`)

| Feature | Status | Notes |
|---------|--------|-------|
| Request body parsing | ✅ Full | `model`, `messages`, `system`, `tools`, `tool_choice`, `max_tokens`, `stream`, `thinking`, `metadata` |
| Auth header (`x-api-key`) | ✅ Full | Extracted via `extractToken()` |
| Anthropic-Version header | ✅ Forwarded | `Anthropic-Version: 2023-06-01` in all responses |
| Streaming (SSE) | ✅ Full | All event types emitted correctly |
| Non-streaming (JSON) | ✅ Full | Correct Anthropic response schema |
| Tool use | ✅ Full | `tool_use` blocks in assistant content |
| Tool results | ✅ Full | `tool_result` blocks in user content |
| Thinking blocks | ✅ Full | Extended thinking → `thinking` content blocks |
| Multi-turn conversation | ✅ Full | Full history preserved |
| System prompt | ✅ Full | String and array formats both supported |

### SSE Event Types

| Event | Emitted | Format |
|-------|---------|--------|
| `message_start` | ✅ Immediately | Includes `id`, `model`, `role`, `usage` |
| `ping` | ✅ Every 5s | Keepalive |
| `content_block_start` | ✅ | text/thinking/tool_use |
| `content_block_delta` | ✅ | text_delta / thinking_delta / input_json_delta |
| `content_block_stop` | ✅ | On block completion |
| `message_delta` | ✅ | `stop_reason`, `output_tokens` |
| `message_stop` | ✅ | End of stream |
| `error` | ✅ | On failure |

### Tool Choice Compatibility

| `tool_choice` type | Gemini mapping | Status |
|-------------------|----------------|--------|
| `{"type":"auto"}` | `AUTO` | ✅ |
| `{"type":"any"}` | `ANY` | ✅ |
| `{"type":"tool","name":"foo"}` | `ANY + allowedFunctionNames: ["foo"]` | ✅ |
| `{"type":"none"}` | `NONE` | ✅ |

### HTTP Methods

| Method | Status |
|--------|--------|
| POST | ✅ Full |
| OPTIONS | ✅ CORS preflight |
| HEAD | ✅ Health check |

---

## Model Name Compatibility

Claude Code sends Anthropic model names. The gateway maps them to Gemini models:

| Anthropic Model | Gemini Primary | Fallback Chain |
|----------------|----------------|----------------|
| `claude-opus-4-5`, `claude-opus-4`, `claude-4-opus` | `gemini-2.5-flash` | `gemini-3-flash-preview`, `gemma-4-31b-it` |
| `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-4-sonnet` | `gemini-2.5-flash` | `gemini-3.1-flash-lite-preview`, `gemini-flash-latest` |
| `claude-3-7-sonnet`, `claude-3-5-sonnet`, `claude-3-opus` | `gemini-2.5-flash` | `gemini-3.1-flash-lite-preview`, `gemini-flash-latest` |
| `claude-haiku-4-5`, `claude-4-haiku`, `claude-3-5-haiku`, `claude-3-haiku` | `gemini-2.5-flash-lite` | `gemini-flash-lite-latest`, `gemini-flash-latest` |

Task-based routing overlays the above:
- REASONING tasks shift primary to `gemma-4-31b-it`
- COMPACTION tasks shift primary to `gemma-4-26b-a4b-it`

---

## Error Response Compatibility

All errors returned in Anthropic error format:
```json
{
  "type": "error",
  "error": {
    "type": "authentication_error|invalid_request_error|api_error|overloaded_error",
    "message": "..."
  }
}
```

| Gemini Status | Anthropic Error Type | HTTP Status |
|--------------|---------------------|-------------|
| 401, 403 | `authentication_error` | 401 |
| 400 | `invalid_request_error` | 400 |
| 429 | `rate_limit_error` | 429 |
| 529 / all keys exhausted | `overloaded_error` | 529 |
| 500, 503 | `api_error` | 500 |

---

## Web Search Compatibility

The gateway supports Anthropic's `web_search` server tool:
- Partitioned from function tools before sending to Gemini
- Executed via internal search loop (non-streaming)
- Results injected into context before final Gemini call
- Compatible with Anthropic's `tool_result` format for search results

---

## Known Limitations

| Limitation | Impact | Workaround |
|-----------|--------|-----------|
| Gemma models are text-only | Images stripped before sending | `[image omitted]` placeholder inserted |
| `gemini-flash-*` max output: 8192 tokens | Capped automatically | `maxOutputTokens` reduced in retry on 400 |
| `thoughtSignature` only valid per-model | Stripped on fallback | Done automatically in retry loop |
| Tool schemas: no `oneOf`/`anyOf`/`allOf` | Flattened to first branch | Union types lose alternatives |
| No file uploads | Not supported by gateway | Claude Code doesn't use file uploads via API |
