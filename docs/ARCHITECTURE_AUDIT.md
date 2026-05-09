# ARCHITECTURE_AUDIT.md

Scope: Anthropic-API → Gemini-API translation gateway. This document audits **only** the translator. The gateway is stateless, runs on Next.js Edge runtime, and never executes tools — clients (e.g. Claude Code) execute tools locally and replay results in subsequent turns.

## 1. Request translation correctness

File: [lib/transformers/request.ts](lib/transformers/request.ts)

| Item | Status | Notes |
|---|---|---|
| `system` (string or array) → `systemInstruction` | OK | Text-block extraction handles both string + array forms. |
| `messages[].content` text/image/thinking blocks → Gemini `parts` | OK | base64 image → `inlineData`; URL image → `fileData`. |
| Role mapping `assistant` → `model` | OK | |
| Trailing-`model` history fix-up | OK | Appends a `user: "Continue"` turn so Gemini accepts the request. |
| Empty-history guard | OK | Inserts placeholder user turn. |
| Leading-non-`user` guard | OK | Prepends placeholder. |
| `max_tokens` clamping per model | OK | `MODEL_MAX_OUTPUT_TOKENS` table with 512-token safety margin. |
| `temperature` / `top_p` / `top_k` (40 cap) | OK | |
| `stop_sequences` (max 5) → `stopSequences` | OK | |
| `thinking.type === "enabled"` → `thinkingConfig` | OK | Budget clamped to 24,576; allow-list of thinking-capable models. |
| `tool_choice` (`auto`/`any`/`tool`/`none`) → `toolConfig` | OK | Sanitizes allowed function name. |
| `safetySettings` (BLOCK_NONE) | OK | Required for code/agent traffic. |
| Conversation summarization / compaction | OK | `compactMessagesDetailed` with rolling summary in Redis. |
| Tool-output archive (large results) | OK | Threshold + `keepRecent` policy. |
| Per-turn signature/name lookup batched via `mget` | OK | Avoids N RTTs on long histories. |

### Edge cases that are correctly handled
- Tool-use without a stored `thoughtSignature` is **demoted to text** (`[Action: I am calling tool …]`) so reasoning-enabled Gemini models do not 400 on a bare `functionCall`. The corresponding `tool_result` is also coerced to text.
- Sanitized Gemini tool names (`a-zA-Z0-9_` only) are used in `functionCall.name` while Anthropic-side original names are preserved via `originalToolNames` for the response path.

### Minor risk
- If the user passes a `tool_use.input` that is not a plain object (e.g. `null`), it is coerced to `{}` on the way out. This is correct, but a malformed *historical* `tool_use` from a non-Claude-Code client could still trip up the model. Low impact.

## 2. Tool schema mapping correctness

File: [lib/transformers/tools.ts](lib/transformers/tools.ts)

| Item | Status |
|---|---|
| `oneOf`/`anyOf`/`allOf` flattened to first branch | OK |
| `const` → single-value `enum` | OK |
| Type normalization (incl. nullable arrays) | OK |
| `enum` forced to STRING type per Gemini constraint | OK |
| Format whitelist (`date-time`, numeric formats) | OK |
| `OBJECT.properties` always present, `required` filtered | OK |
| Zero-arg tools omit `parameters` entirely | OK — Gemini rejects empty-properties OBJECT |
| Name sanitization (`[^a-zA-Z0-9_]` → `_`) | OK |
| Original-name reverse map populated | OK |

Gaps:
- `convertSchema` recurses on `oneOf[0]` only — a tool whose root schema is a `oneOf` of distinct shapes will lose alternative branches silently. Acceptable trade-off for Gemini's lack of unions; consider logging a warning when this happens.
- No depth limit on recursion. A pathological self-referencing schema would loop forever. Practical risk near zero (no `$ref` resolver), but a depth guard (e.g. 32) is cheap insurance.

## 3. Tool result roundtrip integrity

Files: [response.ts](lib/transformers/response.ts), [stream.ts](lib/transformers/stream.ts), [request.ts](lib/transformers/request.ts), [repair.ts](lib/transformers/repair.ts)

Roundtrip path:
1. Gemini emits `functionCall { name, args, thoughtSignature? }` — possibly streamed.
2. Gateway:
   - Generates `toolu_<nanoid>` ID.
   - Maps it to `originalName` for the client.
   - Persists `gemini:toolname:<id>` and `gemini:thought:<id>` in Redis (TTL 3600s).
   - Repairs args against the original Anthropic `input_schema` ([repair.ts](lib/transformers/repair.ts)).
   - Emits Anthropic `tool_use` block.
3. Client executes, replies in next turn with `tool_result { tool_use_id, content, is_error? }`.
4. Gateway resolves the original `functionCall.name` via Redis → emits Gemini `functionResponse { name, response: { result } }`.

| Concern | Status |
|---|---|
| ID generation collision-safe | OK — nanoid 24 chars |
| Sanitized vs. original name distinction | OK — sanitized goes to Gemini, original to client |
| Lost signature → demote to text | OK |
| Stringified-JSON args from Gemini | OK — `repair.ts` re-parses |
| Missing required fields | OK — defaults injected |
| Wrong-typed args (string→number, etc.) | OK — coerced |
| `is_error` flag from client | **Surfaced only via loop detector.** The error flag itself is lost when forwarding `tool_result` text to Gemini as `functionResponse.result`. Low impact because the error text usually contains "Error:" / `ENOENT` / etc., and the model can still see it. Adding an explicit `{ ok: false, error: ... }` envelope around `result` would be cleaner; see TOOL_REPAIR_IMPROVEMENTS.md. |
| Empty tool result | OK — replaced with `"Tool executed (empty result)."` |
| Large outputs | OK — head+tail truncation with archive in Redis |

## 4. Retry-loop detection

**Two distinct retry concepts exist:**

(a) **Gateway↔Gemini retry** — implemented in [retry-engine.ts](lib/retry-engine.ts). Concerned with key rotation, model fallback, signature/thinking stripping, cache invalidation, max_tokens clamping. Audit notes in section 8.

(b) **Client-side tool retry loops** — the model keeps emitting the same failing `tool_use`. This is the loop you reported. The gateway has no control over the client's tool execution, but it DOES see the full message history and can detect blind retries.

**New mitigation added:** [lib/transformers/loop-detector.ts](lib/transformers/loop-detector.ts). It walks `messages` from the tail backward, builds `(tool_use, tool_result)` pairs, computes a stable signature `${name}|${stableStringify(input)}`, and counts consecutive failed pairs with the same signature. When the count reaches `MIN_REPEATS = 2`, corrective guidance is appended to `systemInstruction`. Wired into [request.ts](lib/transformers/request.ts).

See **RETRY_LOOP_FIXES.md** for details.

## 5. Streaming SSE correctness

File: [lib/transformers/stream.ts](lib/transformers/stream.ts)

| Item | Status |
|---|---|
| `message_start` / `ping` emitted before heavy work | OK — beats Vercel 25s init timeout |
| `content_block_start` / `_delta` / `_stop` ordering | OK |
| `thinking` block lifecycle with `signature_delta` flush | OK |
| `tool_use` block with `input_json_delta` (whole JSON) | OK |
| Cross-block transitions (text↔thinking↔tool) all close prior block | OK |
| `<think>` tag stripping for cross-model compat | OK |
| `[Action: …]` text-fallback recovery → real `tool_use` | OK — important for non-thinking fallbacks |
| Suffix-prefix buffering to avoid splitting `<think` partials | OK |
| `message_delta` with correct `stop_reason` | OK — `tool_use` overrides |
| `message_stop` always emitted (even on error) | OK |
| Client-disconnect guard (`safeEnqueue`) | OK |
| `pingInterval` cleared in `finally` | OK |

Gaps:
- The current text buffering uses `cleanedText.replace(...)` on the whole accumulated text every chunk — O(N²) in chunk count. For very long responses this is measurable but not catastrophic. Defer optimization.
- `inToolCall` is set but `tool_use` is closed by the *next* part, not at end of the current `processLine`. Final-cleanup branch handles it. OK.

## 6. Malformed-tool-argument repair

File: [lib/transformers/repair.ts](lib/transformers/repair.ts)

Solid. Handles:
- Stringified-JSON object/array roots.
- Type coercion across all primitive types.
- Missing-required injection with `default` preference.
- Nullable schemas.
- Top-level non-object → `{ items: [...] }` for array roots, `{}` otherwise.

See **TOOL_REPAIR_IMPROVEMENTS.md** for proposed enhancements.

## 7. Model fallback correctness

File: [lib/model-router.ts](lib/model-router.ts) + [retry-engine.ts](lib/retry-engine.ts)

| Item | Status |
|---|---|
| Claude→Gemini chain selection by model class | OK |
| Redis override (`models:registry`) | Present (per CLAUDE.md). |
| `last working model` cached per (user, model) | OK — 1800s TTL |
| Fallback consumed on 4xx body errors and 5xx | OK |
| `overloadedModels` set → fast-fail when chain exhausted | OK — prevents 25s pile-up |
| Cache invalidation on `cachedContent` 400 | OK |
| `thoughtSignature` strip on model switch | OK — paired with `stripThinking` |
| Max-token override extracted from error text | OK |

Gaps:
- `maxRetries = max(configured, 2*fallbacks + 2)` is generous but means a transient pool exhaustion can take ~10 attempts. If `KEY_COOLDOWN_429 = 60s`, this is fine. Document this.
- No circuit breaker per *user*: a single user with bad tool history can repeatedly burn fallbacks. Not exploitable (rate limits are per-key not per-user) but worth metric tracking.

## 8. System-prompt robustness for tool usage

Currently, the gateway is mostly **prompt-passthrough** — it does not augment the system prompt except for the new loop-detector guidance. Claude Code's own system prompt drives tool behavior. This is the right default (do not silently mutate user prompts), but several **low-risk additions** are valuable. See **PROMPT_UPGRADES.md**.

## 9. Edge-runtime compatibility

[route.ts](app/api/v1/messages/route.ts) declares `export const runtime = 'edge'`. Verified:
- No `fs`, `path`, `child_process`, `process.cwd()`, `Buffer` reliance in transformer paths.
- `nanoid`, `Upstash Redis (REST)`, native `fetch`, `TextEncoder/Decoder`, `ReadableStream` — all edge-safe.
- Loop detector is pure JS — no Node APIs.
- Optional: `setInterval` for pings is edge-supported; cleared in `finally`.

OK.

## 10. Security & robustness

| Concern | Status |
|---|---|
| Auth check before body parse — no | Body parsed first, then `validateUserKey`. Acceptable; body is JSON-only and 4xx returned on auth fail. |
| API key never echoed to client | OK |
| Unknown `anthropic-beta` headers silently ignored | OK |
| Schema-injection via tool `description` | Forwarded as-is — model sees it. Same trust model as Anthropic. |
| Prompt injection via tool_result text | Same as Anthropic. Loop detector and gateway notes are scoped to `systemInstruction`, not user content. |

## Summary

The translator is in good shape on translation correctness, schema mapping, repair, streaming, and fallback. The only **structural** gap was missing detection of repeated identical failed tool invocations. That is now addressed. Remaining items are improvements rather than bugs and are tracked in the companion documents.
