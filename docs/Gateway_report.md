# CoatCard AI Gateway — Comprehensive Architecture Report

> Generated from codebase analysis. Covers all concepts, data flows, and design decisions.

---

## Table of Contents
1. [Overview](#1-overview)
2. [API Entry Points](#2-api-entry-points)
3. [Model Routing](#3-model-routing)
4. [Retry Engine](#4-retry-engine)
5. [Context & Session Management](#5-context--session-management)
6. [Hydration Guard](#6-hydration-guard)
7. [Stream Transformation](#7-stream-transformation)
8. [Request Transformation Pipeline](#8-request-transformation-pipeline)
9. [Overload Recovery](#9-overload-recovery)
10. [Tool Archive](#10-tool-archive)
11. [Auth & Key Management](#11-auth--key-management)
12. [Compaction System](#12-compaction-system)
13. [Observability & Logging](#13-observability--logging)
14. [Test Coverage](#14-test-coverage)
15. [Key Environment Variables](#15-key-environment-variables)
16. [Recent Improvements](#16-recent-improvements)
17. [Architecture Diagram](#17-architecture-diagram)

---

## 1. Overview

The CoatCard AI Gateway is an **Anthropic-to-Gemini translation proxy** built with Next.js (Node.js runtime). It exposes an Anthropic Messages API-compatible interface (`/api/v1/messages`) and translates every request to Google's Gemini API, handling streaming, multi-turn sessions, context compression, model routing, and overload recovery.

**Why it exists**: Claude Code (VS Code extension) speaks the Anthropic SDK protocol. This gateway lets Claude Code run on top of Gemini infrastructure while preserving all Anthropic API semantics (SSE format, tool_use blocks, streaming, usage counting).

**Key design principles**:
- **Agentic first** — built for 45-minute, 100+ tool-call sessions, not single queries
- **Fail gracefully** — every failure path yields a clean SSE `message_stop` rather than a broken connection
- **Context isolation** — old sessions must never leak into new ones
- **Latency layered** — fast-path racing beats slow serial fallback whenever possible

---

## 2. API Entry Points

| Route | Methods | Runtime | maxDuration | Purpose |
|-------|---------|---------|-------------|---------|
| `/api/v1/messages` | POST, OPTIONS, HEAD | nodejs | 2700 s (45 min) | Main chat endpoint (streaming + non-streaming) |
| `/api/v1/models` | GET | nodejs | — | List model aliases (Anthropic-compatible format) |
| `/api/v1/session/clear` | POST | nodejs | — | Explicitly flush all Redis session keys for a conversation |
| `/api/health` | GET | nodejs | — | Health check (Redis ping + version) |
| `/api/auth/login` | POST | nodejs | — | Admin session login |
| `/api/auth/logout` | POST | nodejs | — | Admin session logout |
| `/api/auth/me` | GET | nodejs | — | Current auth context |
| `/api/admin/stats` | GET | nodejs | — | Request/token statistics (10 s cache) |
| `/api/admin/models` | GET | nodejs | — | Model pool diagnostics |
| `/api/admin/keys` | GET, POST, DELETE | nodejs | — | Gemini API key CRUD |
| `/api/admin/reset-keys` | POST | nodejs | — | Reset all keys to healthy state |
| `/api/admin/performance` | GET | nodejs | — | Latency/TTFT metrics |
| `/api/admin/activity` | GET | nodejs | — | Last 100 activity log entries |
| `/api/admin/system` | GET, POST | nodejs | — | System settings (racing mode, etc.) |
| `/api/admin/logs` | GET | nodejs | — | Event logs per request |
| `/api/cron/metrics` | GET | nodejs | — | Periodic metrics snapshot |
| `/api/cron/key-recovery` | GET | nodejs | — | Restore keys from cooldown |

**Why `maxDuration = 2700` (45 min)?**  
Claude Code agentic sessions can run for 30–45 minutes, executing dozens of tool calls. Vercel/Next.js defaults to 10 s or 60 s — far too short. The 2700 s limit covers the full session lifetime.

**Why Node.js runtime (not Edge)?**  
`ioredis` (the Redis client) uses TCP sockets, which are unavailable in the Edge runtime. All routes must be Node.js.

---

## 3. Model Routing

### 3.1 Model Pool (Allowlist)

```
gemini-2.5-flash            ← primary HEAVY_CODING
gemini-2.5-flash-lite       ← CHAT / fast tasks
gemini-3-flash-preview      ← LIGHT_CODING primary
gemini-3.1-flash-lite-preview
gemini-flash-latest
gemini-flash-lite-latest
gemma-4-31b-it              ← last-resort overload fallback
gemma-4-26b-a4b-it          ← last-resort fallback + compaction model
```

All models are validated at request time. Unknown model names fall back to `gemini-2.5-flash`.

### 3.2 Task Types & Routing Chains

| Task Type | Primary Model | Fallback Chain | When Selected |
|-----------|--------------|----------------|---------------|
| **CHAT** | gemini-2.5-flash-lite | gemini-flash-lite-latest | Single-turn greetings, health checks |
| **LIGHT_CODING** | gemini-3-flash-preview | gemini-2.5-flash-lite, gemini-flash-latest | Small code tasks (<3 files, <3 tools, <4 exec ops) |
| **HEAVY_CODING** | gemini-2.5-flash | gemini-3-flash-preview, gemini-3.1-flash-lite-preview | 5+ tools, architecture signals, multi-file, thinking enabled, long sessions (>15 msgs) |
| **REASONING** | gemma-4-31b-it | gemma-4-26b-a4b-it, gemini-2.5-flash | Formal proofs, deductive logic (NOT code analysis) |
| **WEB_SEARCH** | gemini-3-flash-preview | gemini-2.5-flash, gemini-flash-latest | `web_search` tool present or explicit internet lookup intent |
| **COMPACTION** | gemma-4-26b-a4b-it | gemma-4-31b-it, gemini-2.5-flash | Background context summarization |
| **HEALTH_CHECK** | gemini-2.5-flash-lite | gemini-flash-lite-latest | Synthetic probes only |

### 3.3 Behavioral Signal Extraction

The router inspects each request before routing:

| Signal | How Detected | Effect |
|--------|-------------|--------|
| `toolCount` | Count of tool schemas in request | ≥5 → HEAVY_CODING |
| `architectureSignal` | Schema/migration/monorepo keywords in messages | → HEAVY_CODING |
| `multiFile` | 3+ unique file paths referenced | → HEAVY_CODING |
| `executionDensity` | bash/write ops (≥4) | → HEAVY_CODING |
| `codeDensity` | Code fences + file paths + stack traces | → LIGHT_CODING if high |
| `explicitReasoning` | Formal proof/logic patterns | → REASONING |
| `webSearch` | Internet lookup intent detected | → WEB_SEARCH |
| `messageCount` | Conversation turn count | >15 → promotes LIGHT_CODING → HEAVY_CODING |

**Long-session promotion**: After 15 turns, even tasks classified as LIGHT_CODING are promoted to HEAVY_CODING. This ensures established sessions get a capable model that won't truncate mid-task.

### 3.4 Sticky Routes (Redis-backed)

The last working model per user is cached:

```
Key: route:v3:{userId}:{anthropicModel}:{routeVersion}
TTL: 3600 s (60 min)  ← covers full agentic session
```

On retry/overload, the sticky route is cleared so the next request re-evaluates. This prevents permanently routing to a degraded model.

### 3.5 Model Registry (Dynamic)

Routes can be updated at runtime via Redis:
- Key: `models:registry` (JSON blob)
- Fallback: Hardcoded local JSON → hardcoded TypeScript defaults

---

## 4. Retry Engine

### 4.1 Overall Strategy

`executeWithRetry()` coordinates a multi-phase retry strategy designed to minimize latency on success while recovering gracefully from overload.

**Max retries**: `min(configuredMax, (fallbacks.length × 2) + 2, 12)`

### 4.2 Phase 0: Key Race (Parallel)

- Fires multiple API keys against the **same primary model** simultaneously
- Timeout: `FAST_PATH_RACE_TIMEOUT` (default 3.5 s)
- **Win condition**: First 2xx response wins; others cancelled
- **Why**: A single Gemini API key may be rate-limited while others are healthy. Racing eliminates the "bad key on first try" penalty.
- On failure (all keys 4xx/5xx) → falls through to serial loop

### 4.3 Phase 0b: Model Race (Parallel)

After key race fails:
- Races primary + first N fallback models simultaneously
- Task-specific count: HEAVY_CODING = 3 models, LIGHT_CODING = 2, CHAT = disabled
- Overload mode: always 3 models regardless of task
- **Why**: Eliminates the latency penalty of trying models one-by-one during rolling outages

### 4.4 Serial Retry Loop

When racing doesn't produce a winner:

1. **Get healthiest key** — from Redis sorted set (by health score)
2. **Token pressure check** — if context is huge, pre-compact it
3. **Strip thought signatures** — if switching models (signatures are model-specific)
4. **Strip images** — if falling back to text-only model
5. **Apply cache** — wrap large payloads in `cachedContent` reference (Gemini explicit cache)
6. **Call Gemini** — with `MODEL_CALL_TIMEOUT` (default 55 s)
7. **Handle response**:
   - `403` → bad key → mark revoked, retry
   - `429` → rate limited → backoff, retry
   - `503` → overloaded → switch model, use `computeOverloadBackoff()`
   - `5xx` → emergency compact → call `recoverFromOverload()`
   - `400` → parse error, token limit, signature mismatch → handle specifically
   - `2xx` → success → return `Response` object, remember sticky route

### 4.5 Backoff Formula

```
base = min(1500, 120 × 2^(attempt - 1)) ms
jitter = random(0, 120) ms
total = base + jitter

attempt 1: ~120–240 ms
attempt 2: ~240–360 ms
attempt 3: ~480–600 ms
attempt 4: ~960–1080 ms
attempt 5+: ~1500–1620 ms
```

### 4.6 Model Call Timeout

```typescript
MODEL_CALL_TIMEOUT = 55_000 ms (55 s)   // default (was 20s, raised for multi-turn context)
```

For streaming requests, this is the time to receive response **headers** from Gemini (not the full body). The streaming body uses a separate 90 s per-chunk timeout.

Multi-turn conversations with long tool histories can take Gemini 20–50 s to begin generating. The previous 20 s limit caused spurious mid-task failures that looked like dropped streams from the client side.

---

## 5. Context & Session Management

### 5.1 ConversationId Derivation

```typescript
// Explicit ID (highest priority — from client metadata):
conversationId = body.metadata?.conversation_id
              || body.conversation_id
              || body.session_id
              || body.thread_id

// Fallback — hash-derived (WARNING: may collide across sessions in same workspace):
anchor = `${userId}|${systemText.slice(0, 400)}|${firstUserMsg.slice(0, 400)}`
conversationId = `anon-${stableHash(anchor)}`
```

**Why hash fallback?** Claude Code doesn't always send an explicit `conversation_id`. The hash gives a stable ID per session start point. The downside: two sessions starting with the same first message in the same workspace produce the same hash — hence the fresh-session hydration gate.

### 5.2 Redis Key Patterns (Session Data)

| Pattern | Type | TTL | Purpose |
|---------|------|-----|---------|
| `context:summary:{convId}` | string | 6 h | Rolling context summary |
| `opstate:v3:{convId}` | JSON | 6 h | Operational state (shell, workspace, artifacts, failures) |
| `context:emergency:{convId}` | JSON | 6 h | Emergency compaction state (count + body) |
| `context:workspace:{convId}` | string | 6 h | Companion workspace-root (explicitly saved each request) |
| `context:compacted:{convId}:{rangeId}` | JSON | 6 h | AI-generated compacted memory block |
| `tool_archive:{sessionKey}:{hash}` | string | 90 min | Archived large tool output (file reads, bash results) |
| `route:v3:{userId}:{model}:{version}` | string | 60 min | Sticky model route |
| `gemini:key:{keyId}` | hash | — | Gemini API key metadata |
| `gemini:key_pool` | zset | — | Key health ranking (sorted by score) |
| `admin:session:{sid}` | string | 24 h | Admin dashboard session |
| `activity:log` | list | — | Last 1000 activity entries (capped) |
| `stats:*` | various | — | Daily/global metrics |

### 5.3 `POST /api/v1/session/clear`

Explicitly deletes all known session keys for a `conversation_id`:

```json
// Request:
{ "conversation_id": "your-conversation-id" }

// Response:
{ "cleared": true, "conversation_id": "...", "keys_deleted": 4,
  "note": "Compacted range blocks expire automatically via TTL." }
```

Deleted keys: `context:summary:*`, `opstate:v3:*`, `context:emergency:*`, `context:workspace:*`  
Not deleted (auto-expire): `context:compacted:*` (pattern-scan not supported; TTL handles cleanup)

---

## 6. Hydration Guard

The hydration guard (`lib/context/hydration-guard.ts`) is a multi-gate safety layer that decides whether Redis-stored session context (rolling summaries, compacted memory, operational state) is safe to inject into the current request.

**Core rule**: Compacted memory MUST NOT be injected unless session continuity is proven.

### 6.1 All 4 Gates (must all pass)

#### Gate 1: `/clear` Reset Detection
- Scans last 10 messages for: `/clear`, `/reset`, `clear context`, `reset session`
- **Fail reason**: `HYDRATION_SKIPPED_CLEAR_RESET`
- **Why**: User explicitly requested a fresh start

#### Gate 2: Workspace Root Matching
- Extracts workspace from `<workspacePath>`, `<cwd>`, `Cwd:`, `Current Working Directory (...)` in current system + first 4 messages
- Compares with stored companion key (`context:workspace:{convId}`)
- Both null → pass (can't assert mismatch)
- One known, one null → pass (first request)
- Both known but different → FAIL (strict: `/path/a` ≠ `/path/a/subdir`)
- **Fail reason**: `HYDRATION_SKIPPED_WORKSPACE_MISMATCH`
- **Why**: Prevents memory from workspace A bleeding into workspace B

#### Gate 3: Fresh Session Detection
- Fires when: `messages.length === 1` AND `hasExplicitConversationId === false` AND no continuation signal
- **Fail reason**: `HYDRATION_SKIPPED_FRESH_SESSION`
- **Why**: Hash-derived IDs can collide. A new Claude Code window typing "analyze this codebase" would get the same hash as the previous session and load stale context. This gate blocks it.
- **Exception**: Continuation signals (`continue`, `resume`, `pick up`, `next step`, etc.) override this gate even on single-message sessions

#### Gate 4: Semantic Continuity (Low Continuity Check)
- Runs only when Gates 1–3 pass
- Single-message sessions with explicit ID: fails if trivial greeting (hi/hello/hey/ping/test)
- Multi-turn sessions: always pass (any reply is valid continuation)
- **Fail reason**: `HYDRATION_SKIPPED_LOW_CONTINUITY`

### 6.2 Established Session Fast Path

When messages already contain a `<!-- compacted:v2 -->` or `<!-- compacted:v1 -->` sentinel:
- Session is proven — only Gates 1 and 2 apply
- Continuity and fresh-session gates are skipped
- This is the `evaluateHydrationForEstablishedSession()` path

### 6.3 Redis Flush on Fresh Session

When `HYDRATION_SKIPPED_FRESH_SESSION` is detected, the gateway immediately deletes stale Redis keys for that `conversationId` (fire-and-forget):

```typescript
const staleKeys = [summaryKey, operationalStateKey(convId), 
                   `context:emergency:${convId}`, `context:workspace:${convId}`];
redis.del(...staleKeys).catch(() => {});
```

This ensures the next compaction starts with a clean slate instead of accumulating stale data.

---

## 7. Stream Transformation

### 7.1 Gemini SSE → Anthropic SSE

The gateway translates Gemini's `streamGenerateContent` response into Anthropic's Messages API SSE format.

**Input** (Gemini SSE):
```
data: {"candidates":[{"content":{"parts":[{"text":"Hello!"}]},"finishReason":"STOP"}],"usageMetadata":{...}}
```

**Output** (Anthropic SSE):
```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}
```

### 7.2 Immediate Initial Response

To satisfy platform "initial response" timeouts (e.g., 25 s on Vercel):
1. Stream yields `message_start` event **immediately** (before any heavy work)
2. Stream yields `ping` event
3. Only then does the heavy work begin (Redis lookups, Gemini request, etc.)

Without this, the 25 s no-response window would expire during context loading.

### 7.3 Chunk Read Timeout

```typescript
withTimeout(reader.read(), 90_000, 'stream-chunk-read')
```

If Gemini sends no bytes for **90 seconds**, the stream breaks gracefully:
- Logs a warning: `[stream] Gemini chunk read timed out after 90 s`
- Emits `message_stop` cleanly
- Does NOT throw an error to the client

**Why 90 s?** Gemini extended thinking can take 30–60 s mid-response between chunks (especially for reasoning-heavy tasks). The previous 30 s limit killed streams mid-response on long agent runs.

### 7.4 Keepalive Pings

```typescript
pingInterval = setInterval(() => {
  safeEnqueue(new TextEncoder().encode(`event: ping\ndata: {"type":"ping"}\n\n`));
}, 2_000); // every 2 seconds
```

Sent every **2 seconds** throughout the entire stream lifetime. This prevents:
- Proxy idle-connection timeouts (many proxies close after 30–60 s of silence)
- Claude Code client connection drops during long Gemini thinking phases
- CDN/load balancer idle resets

Previous value was 5 s — raised to 2 s because Gemini multi-turn responses can take 20–50 s to start, and some proxies reset at 20 s.

### 7.5 Content Block Types

| Gemini Part | Anthropic Block | Notes |
|-------------|----------------|-------|
| `{text: "...", thought: true}` | `type: "thinking"` | Extended thinking block |
| `{text: "..."}` | `type: "text"` | Regular text content |
| `{functionCall: {...}}` | `type: "tool_use"` | Tool call with remapped ID |
| (action text in text) | `type: "tool_use"` | Action-text recovery (BUG-003 fix) |

### 7.6 Tool ID Remapping

Gemini tool names use alphanumeric + underscore. Anthropic tool IDs are `toolu_XXXX`. The gateway maintains a bidirectional map:
- `toolIdMap`: maps Anthropic tool ID → Gemini function name
- `originalToolNames`: maps Gemini name → original Anthropic name (preserves case, dots, hyphens)

### 7.7 Stop Reason Mapping

| Gemini `finishReason` | Anthropic `stop_reason` | Notes |
|----------------------|------------------------|-------|
| `STOP` | `end_turn` | Normal completion |
| `MAX_TOKENS` | `max_tokens` | Output truncated (recently fixed — was wrongly emitting `tool_use`) |
| `SAFETY` | `stop_sequence` | Safety filter triggered |
| `FUNCTION_CALL_DETECTED` | `tool_use` | Tool call present |
| (any, if tool seen) | `tool_use` | Override: saw tool → stop for tool execution |

**MAX_TOKENS fix**: If the model hit its output token limit mid-response, the stop reason is now correctly `max_tokens`. Previously, if any tool had been seen, it would emit `tool_use` — causing Claude Code to think tool execution completed normally when it was actually truncated.

### 7.8 TTFT & Telemetry

At stream close, the gateway logs:
```json
{
  "requestId": "req_abc123",
  "ttft_ms": 842,       // time to first token
  "total_ms": 18342,    // total stream duration
  "output_tokens": 1247,
  "stop_reason": "tool_use",
  "saw_tool_use": true
}
```

---

## 8. Request Transformation Pipeline

### 8.1 Full Pipeline

```
Anthropic Request
  │
  ├─ 1. Derive conversationId + summaryKey (explicit or hash)
  │
  ├─ 2. Detect hasExplicitConversationId (affects hydration gate)
  │
  ├─ 3. Extract currentWorkspaceRoot (system prompt + first 4 messages)
  │
  ├─ 4. Load storedWorkspaceRoot (Redis companion key + opstate fallback)
  │
  ├─ 5. Run Hydration Guard (4 gates → verdict: allow / skip + reason)
  │     └─ If FRESH_SESSION → delete stale Redis keys (fire-and-forget)
  │
  ├─ 6. START parallel Redis fetch (hidden behind sequential work):
  │     Promise.all([redis.get(summaryKey), getHealthiestKeyObj(userId)])
  │
  ├─ 7. Load Emergency Compaction State (if hydration allowed)
  │     └─ Apply: rewrite messages to canonical compacted form
  │
  ├─ 8. Hydrate Compacted Markers (if hydration allowed)
  │     └─ Find <!-- compacted:v2 --> sentinels → lookup Redis → restore summaries
  │
  ├─ 9. Await parallel fetch results (rolling summary + API key)
  │
  ├─ 10. Run Adaptive Compaction
  │      └─ If messages > target tokens → compact middle turns, generate summary
  │      └─ Store new summary in Redis (fire-and-forget)
  │
  ├─ 11. Save companion workspace key (fire-and-forget)
  │
  ├─ 12. Transform messages: Anthropic → Gemini format
  │      └─ Tool schemas, system instruction, output token ceiling, cache config
  │
  └─ Return: { geminiBody, webSearchConfig, requestContext }
```

### 8.2 Parallel Redis Fetch Optimization

```typescript
// BEFORE: sequential — 2 separate Redis RTTs (added ~50ms latency)
const rollingSummary = await redis.get(summaryKey);
const keyObj = await getHealthiestKeyObj(userId);

// AFTER: parallel — 1 effective RTT (hides latency behind sequential ops)
const parallelFetch = Promise.all([
  redis.get(summaryKey).catch(() => ''),
  getHealthiestKeyObj(userId),
]);
// ... do sequential work (emergency state, marker hydration) ...
const [rollingSummary, keyObj] = await parallelFetch;  // already done!
```

Saves ~50 ms per request on established sessions by overlapping the Redis RTT with other mandatory sequential operations.

---

## 9. Overload Recovery

### 9.1 OVERLOAD_FALLBACK_CHAIN

```
1. gemini-2.5-flash            (primary — best capability)
2. gemini-3-flash-preview
3. gemini-3.1-flash-lite-preview
4. gemini-flash-latest
5. gemma-4-31b-it              (last resort — separate Google infrastructure)
6. gemma-4-26b-a4b-it
```

**Why Gemma as last resort?** Gemma models run on separate Google infrastructure. When all Gemini endpoints are experiencing an outage, Gemma may still be reachable. This prevents total failure during rolling Gemini outages.

### 9.2 `computeOverloadBackoff(attempt)`

```
Level 1 (attempt 1): 150 ms base + jitter
Level 2 (attempt 2): 400 ms base + jitter
Level 3 (attempt 3): 1000 ms base + jitter
Level 4 (attempt 4): 2200 ms base + jitter
Level 5+ (attempt 5+): 3700 ms base + jitter (capped)
```

Progressive backoff reduces hammering during sustained outages while recovering quickly on transient spikes.

### 9.3 `waitBeforeAllModelsExhausted()`

When all 6 chain models have been tried and are overloaded:
```typescript
await sleep(2000 + Math.random() * 500); // 2.0–2.5 s
```

Before giving up entirely, the gateway waits ~2 s. This handles the case where a brief rate-limit window clears within seconds, avoiding false "all models exhausted" errors that would otherwise immediately propagate to the client.

### 9.4 Key Cooldown

- Duration: **10 seconds** (was 30 s — too aggressive with few keys)
- Trigger: any 429 or overload response
- Effect: key removed from active pool for 10 s
- Auto-recovery: next `getHealthiestKeyObj()` call after 10 s restores the key

---

## 10. Tool Archive

### 10.1 Purpose

Large tool outputs (file reads of 500 lines, bash outputs of 50KB) consume enormous context window space. The tool archive stores them in Redis and replaces the inline content with a compact reference tag.

### 10.2 How It Works

**Detection**: Scan all `tool_result` blocks in message history for content > 8,000 chars.

**Archiving** (oldest results first, keep 3 most recent inline):
```
Hash content → FNV-1a hash (first 20k chars)
Store in Redis: tool_archive:{sessionKey}:{hash} with 90-min TTL
Replace content with: [GATEWAY ARCHIVE: Read output (500 lines, 42KB) — stored in session cache for 90 min. ref:{hash}]
```

**Deduplication**: Reading the same file twice produces the same hash → one Redis entry.

**Token savings**:
- Example: 5 × 50KB Read results → ~65,000 tokens saved
- Enables 5+ additional turns before compaction triggers

### 10.3 Configuration

| Setting | Default | Purpose |
|---------|---------|---------|
| Threshold | 8,000 chars | Minimum size to archive |
| Keep recent | 3 | Most recent tool results kept inline |
| TTL | 5,400 s (90 min) | Covers full 45-min session + 45-min headroom |

**Why 90-min TTL?** The main route has `maxDuration = 2700 s` (45 min). A session that runs for 45 min and then makes one more request still needs its archived tool outputs. 90 min gives 100% headroom.

---

## 11. Auth & Key Management

### 11.1 User API Key Validation

```typescript
validateUserKey(token):
  1. Check MASTER_API_KEY (env var — always valid)
  2. Lookup user:key:{token} in Redis
  3. Verify status === 'active'
  4. Fire-and-forget: increment usage_count, update last_used
```

### 11.2 Healthiest Key Selection

```typescript
getHealthiestKeyObj(userId):
  1. Fetch gemini:key_pool (sorted set, score = health)
  2. Apply sticky key preference (if user has used a key recently)
  3. Get metadata for top 10 keys (single Redis pipeline — 1 RTT)
  4. Filter: skip revoked, skip cooldown-not-expired
  5. Lazy recovery: if cooldown expired, restore key immediately
  6. Fallback scan: if top 10 exhausted, scan next 20, then 20 more...
  7. Return healthiest available key (even cooldown as absolute last resort)
```

### 11.3 Key Health Scoring

```
gemini:key:{id} hash fields:
  key           — actual API key string
  status        — 'healthy' | 'cooldown' | 'revoked'
  rpm_used      — requests per minute (quota tracking)
  tpm_used      — tokens per minute
  daily_used    — daily usage count
  failure_count — consecutive failures (higher → lower score)
  cooldown_until — Unix timestamp (0 if not on cooldown)
```

Keys are randomly scanned (30% chance per request) to auto-restore expired cooldowns, preventing permanent lockout.

---

## 12. Compaction System

### 12.1 Why Compaction?

Anthropic Claude Code sends full conversation history on every request. After 30+ turns with large tool outputs, this can exceed Gemini's context window (1M tokens for 2.5 Flash, but practical limits are lower due to response budgets). Compaction reduces the history while preserving task continuity.

### 12.2 Compaction Types

#### Fast Compaction (Synchronous — for overload recovery)
- Implemented in: `lib/recovery/overload-recovery.ts`
- Strategy: Remove middle 60% of turns, keep head + tail
- Output: `[N earlier messages compacted for overload recovery...]`
- Trigger: Token pressure detected OR 503/529 overload response

#### Adaptive Per-Request Compaction
- Implemented in: `lib/transformers/compaction.ts`
- Policy: Lite models → 120k token target, standard → 180k token target
- Keep strategy: first 2 turns + last 20 turns
- Trigger: Estimated tokens > target
- Generates rolling summary (heuristic, not AI)

#### AI-Based Compaction (Deep)
- Implemented in: `lib/compactor/ai-compactor.ts`
- Model: `gemma-4-26b-a4b-it` (efficient summarization)
- Input budget: 24,000 chars (transcript)
- Output budget: 900 tokens max
- Extracts: Goal, LatestTurns, ActiveTaskChain, PendingTasks, ToolState, Artifacts, Failures, OperationalMemory
- Stores result: `context:compacted:{convId}:{rangeId}` in Redis (6 h TTL)
- Creates marker: `<!-- compacted:v2 -->\n[COMPACTED RANGE]\nrange_id:{id}\n[/COMPACTED RANGE]`

#### Emergency Compaction (Reactive — during overload)
- Implemented in: `lib/context/emergency-compactor.ts`
- Trigger: Overload (503/529) during an active request
- Count-based strategy:
  - 1st compaction: keep head 2 + tail 5 turns
  - 2nd compaction: keep head 1 + tail 3 turns (maximum reduction)
- Model: `gemma-4-31b-it` → fallback to template summary if model unavailable
- State stored: `context:emergency:{convId}` (tracks count, timestamps)

### 12.3 Compacted Marker Hydration

On the next request, if `<!-- compacted:v2 -->` is found in messages:
1. Extract `range_id` from the marker text
2. Lookup `context:compacted:{convId}:{rangeId}` in Redis
3. Replace the compact marker with the full AI-generated summary block
4. The session "remembers" what happened in the compacted range

---

## 13. Observability & Logging

### 13.1 Request Tracing

Every request gets a unique ID: `req_{timestamp36}_{random6}`

This ID threads through:
- All Redis keys for that request's event log
- `X-Request-Id` response header (returned to Claude Code)
- All `logInfo` / `logWarn` / `logError` calls
- The TTFT telemetry log line

**Why**: Allows correlating a client error report with specific server log entries.

### 13.2 Structured Event Logging

```typescript
logInfo('ROUTING', 'Model routing completed', {
  requestId: 'req_abc123',
  duration: 45,  // ms
  metadata: { requestedModel: 'claude-opus-4-5', resolvedModel: 'gemini-2.5-flash', task: 'HEAVY_CODING' }
});
```

**Log categories**: ACTIVITY, AUTH, ROUTING, KEY_RACE, MODEL_RACE, RETRY, OVERLOAD, KEY_ROTATION, COMPACTION, STREAM, RETRIEVAL, WEB_SEARCH, SUBAGENT, RECOVERY, SYSTEM

### 13.3 TTFT Tracking

```json
{
  "requestId": "req_abc123",
  "ttft_ms": 842,
  "total_ms": 18342,
  "output_tokens": 1247,
  "stop_reason": "tool_use",
  "saw_tool_use": true
}
```

`ttft_ms` = time from stream start to first `content_block_delta` emitted. This measures the model's pre-generation latency (context processing + first token).

### 13.4 Metrics Stored in Redis

| Metric | Keys | Purpose |
|--------|------|---------|
| Request count | `stats:requests`, `stats:daily:*`, `stats:model:*`, `stats:user:*` | Usage analytics |
| Error count | `stats:errors:*` | Reliability tracking |
| Latency (ms) | `stats:latency` list (last 1000) | P95/P99 monitoring |
| Input tokens | `stats:input_tokens:*` | Cost tracking |
| Output tokens | `stats:output_tokens:*` | Cost tracking |

---

## 14. Test Coverage

**707 tests across 66 suites**. Key test files:

| Category | Files | What's Tested |
|----------|-------|---------------|
| **Routing** | task-router, task-complexity, behavior-routing, trivial-routing, model-router-redis | Task classification, behavioral signals, registry loading, long-session promotion |
| **Retry & Recovery** | retry-engine-sticky-route, overload-recovery, fallback-overload, key-racer, key-rotation-overload | Key racing, model fallback chain, overload backoff, sticky routes |
| **Context & Session** | context-isolation, emergency-compaction, token-pressure-compaction, ai-compactor | Hydration guard (all 4 gates), compaction triggers, marker roundtrip |
| **Observability** | event-logger, performance-tracker, metrics-redis | Structured logging, TTFT, metrics storage |
| **Auth & Keys** | auth-redis, admin-session-login | Key validation, admin auth |
| **Stream** | stall-safety, response-watchdog | Chunk timeout, watchdog constants |
| **Tools** | web-search, tool-structure | Tool schema, search integration |
| **Subagents** | subagent-executor, subagent-scheduler, orchestrator-enforcer | Task delegation, resumption, orchestration rules |

---

## 15. Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `REDIS_URL` | **(required)** | ioredis connection string |
| `MASTER_API_KEY` | — | Superuser API key (bypasses user key validation) |
| **Timeouts** | | |
| `MODEL_CALL_TIMEOUT` | 55,000 ms (55 s) | Max time for Gemini to start responding (was 20 s) |
| `COMPACTOR_TIMEOUT` | 8,000 ms (8 s) | Max time for AI compaction model call |
| `REDIS_TIMEOUT` | 3,000 ms (3 s) | Max time for Redis operations |
| `WEB_SEARCH_TIMEOUT` | 8,000 ms (8 s) | Max time for web search |
| `FALLBACK_TIMEOUT` | 5,000 ms (5 s) | Max time for model selection |
| `REQUEST_TIMEOUT` | 2,700,000 ms (45 min) | Hard limit for entire request |
| `STALL_DETECTION_MS` | 30,000 ms (30 s) | Inactivity threshold before recovery |
| **Compaction** | | |
| `CONTEXT_SUMMARY_TTL` | 21,600 s (6 h) | Session data TTL |
| `CONTEXT_COMPACTION_TARGET_TOKENS` | 180,000 | Standard model target |
| `CONTEXT_COMPACTION_TARGET_TOKENS_LITE` | 120,000 | Lite model target |
| `CONTEXT_COMPACTION_KEEP_LAST` | 20 | Tail messages preserved during compaction |
| `CONTEXT_SUMMARY_CHAR_BUDGET` | 3,000 | Max chars for rolling summary text |
| `TOOL_RESULT_MAX_CHARS` | 40,000 | Per-tool-result truncation limit |
| `TOOL_RESULT_TAIL_CHARS` | 4,000 | Bytes preserved at end (file endings) |
| **Tool Archive** | | |
| `TOOL_ARCHIVE_THRESHOLD` | 8,000 chars | Min size to archive |
| `TOOL_ARCHIVE_KEEP_RECENT` | 3 | Recent results kept inline |
| **Emergency Compaction** | | |
| `EMERGENCY_COMPACTION_TTL_SECONDS` | 21,600 | Emergency state TTL |
| `EMERGENCY_COMPACTION_INPUT_CHARS` | 24,000 | Transcript budget for AI summarizer |
| **Retry** | | |
| `MAX_RETRIES` | 3 | Base retry count (actual max is derived formula) |
| `FAST_PATH_RACE_TIMEOUT` | 3,500 ms | Key/model race timeout |
| **Caching** | | |
| `GEMINI_CACHE_ENABLED` | false | Enable Gemini explicit cache (requires billing) |
| `GEMINI_CACHE_MIN_CHARS` | 16,000 | Min payload size for cache creation |
| `GEMINI_CACHE_TTL` | 300 s (5 min) | Cache TTL |

---

## 16. Recent Improvements

### Session Isolation (This Session)

**Problem**: Starting a new Claude Code window in the same workspace could load old session context from a previous conversation (because the hash-based `conversationId` collided with the prior session's key).

**Fix: Fresh-Session Hydration Gate (`HYDRATION_SKIPPED_FRESH_SESSION`)**
- Fires when: single-message request + no explicit `conversation_id` in metadata + no continuation signal
- Continuation signals ("continue", "resume", "pick up", "next step") override this gate
- Multi-turn sessions (messages.length > 1) are exempt — they're proven continuations
- Explicit `conversation_id` → gate skipped (API user wants continuity)

**Fix: Auto-delete stale Redis keys on fresh session**
- When fresh session detected: immediately delete `summary`, `opstate`, `emergency`, `workspace` keys
- Compacted blocks expire via TTL (pattern-scan not supported)

**New endpoint: `POST /api/v1/session/clear`**
- Explicit session flush for any `conversation_id`
- Useful for debugging or manual session reset

### Stream Reliability (Prior Round)

**Fix: `MODEL_CALL_TIMEOUT` 20 s → 55 s**
- Multi-turn Gemini calls with long context can take 20–50 s to begin generating
- The 20 s limit killed the second/third turn responses mid-task
- 55 s gives enough headroom without waiting forever on a truly dead endpoint

**Fix: Chunk read timeout 30 s → 90 s**
- Extended thinking phases can have 30–60 s gaps between chunks
- 30 s was too short; now 90 s before declaring stall

**Fix: Ping interval 5 s → 2 s**
- More aggressive keepalive during long Gemini thinking phases
- Prevents proxy/CDN idle connection resets

**Fix: `MAX_TOKENS` stop reason**
- Gemini `finishReason: MAX_TOKENS` now correctly emits `stop_reason: max_tokens`
- Previously: if any tool was seen, it emitted `tool_use` even on truncated responses
- This gave Claude Code incorrect information, causing it to expect tool execution completion

### Overload Recovery (Prior Round)

**OVERLOAD_FALLBACK_CHAIN**: 4 → 6 models (added `gemma-4-31b-it` and `gemma-4-26b-a4b-it`)
- Gemma runs on separate infrastructure — available during Gemini-wide outages

**`waitBeforeAllModelsExhausted()`**: 2–2.5 s wait before total failure
- Allows transient rate-limit windows to clear

**Improved `computeOverloadBackoff()`**: 5-level exponential curve instead of 3-level flat

### Observability (Prior Round)

**`X-Request-Id` header**: returned to Claude Code for correlation with server logs

**TTFT logging**: every stream completion logs `ttft_ms`, `total_ms`, `output_tokens`, `stop_reason`

### Context Efficiency (Prior Round)

**Parallel Redis fetch**: rolling summary + API key fetched in parallel, hidden behind sequential mandatory work — saves ~50 ms per established session request

**Tool archive TTL**: 30 min → 90 min (covers full 45-min session + 45-min headroom)

**Sticky route TTL**: 30 min → 60 min (covers full session without re-learning)

**Long-session task promotion**: >15 messages automatically promotes LIGHT_CODING → HEAVY_CODING

---

## 17. Architecture Diagram

```
Claude Code (VS Code)
        │ Anthropic SDK HTTP (POST /api/v1/messages)
        ▼
┌─────────────────────────────────────────────────────────┐
│           CoatCard AI Gateway (Next.js + Node.js)       │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 1. AUTH  validateUserKey() + validateAdminKey() │   │
│  └─────────────────────────────────────────────────┘   │
│                          ↓                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 2. ROUTING  getModelMapping()                   │   │
│  │    extractBehavioralSignals() → TASK TYPE       │   │
│  │    sticky route lookup → INTERNAL MODEL         │   │
│  └─────────────────────────────────────────────────┘   │
│                          ↓                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 3. HYDRATION GUARD  (4 gates, all must pass)    │   │
│  │    Gate 1: /clear detection                      │   │
│  │    Gate 2: workspace root match                  │   │
│  │    Gate 3: fresh session (no explicit ID, 1 msg) │   │
│  │    Gate 4: semantic continuity                   │   │
│  │    → allowed: load context from Redis            │   │
│  │    → blocked: flush stale keys (fresh session)   │   │
│  └─────────────────────────────────────────────────┘   │
│                          ↓                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 4. CONTEXT LOADING  (parallel Redis pipeline)   │   │
│  │    rolling summary + compacted blocks           │   │
│  │    operational state + emergency state          │   │
│  └─────────────────────────────────────────────────┘   │
│                          ↓                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 5. COMPACTION  (adaptive per request)           │   │
│  │    if tokens > target: compact + store summary   │   │
│  │    tool archive: inline → Redis → reference tag  │   │
│  └─────────────────────────────────────────────────┘   │
│                          ↓                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 6. EXECUTE WITH RETRY                           │   │
│  │    Phase 0a: Key race (parallel keys)            │   │
│  │    Phase 0b: Model race (parallel models)        │   │
│  │    Serial loop:                                  │   │
│  │      → 403: bad key → mark revoked, retry       │   │
│  │      → 429: rate limit → backoff, retry          │   │
│  │      → 503: overloaded → next fallback model     │   │
│  │      → 5xx: emergency compact → recover          │   │
│  │      → 2xx: success → remember sticky route     │   │
│  │    OVERLOAD_FALLBACK_CHAIN: 6 models (incl Gemma)│   │
│  └─────────────────────────────────────────────────┘   │
│                          ↓                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 7. STREAM TRANSFORMATION                        │   │
│  │    Gemini SSE → Anthropic SSE                   │   │
│  │    Ping every 2s (keepalive)                    │   │
│  │    90s chunk timeout                             │   │
│  │    Tool ID remapping                             │   │
│  │    TTFT + X-Request-Id observability             │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
        │ Anthropic SSE stream (tool_use, text, thinking)
        ▼
Claude Code (displays results, executes tools, sends next turn)

         ┌──────────┐         ┌─────────────────┐
         │  Redis   │         │  Gemini API     │
         │          │         │  (Google)       │
         │ session  │◄────────│                 │
         │ routing  │         │  gemini-2.5-    │
         │ metrics  │         │  flash          │
         │ keys     │         │  gemma-4-31b-it │
         └──────────┘         │  (6 models)     │
                              └─────────────────┘
```

---

*Report generated: reflects current codebase state including all session improvements.*
*Test suite: 707 tests, 66 suites, all passing.*
