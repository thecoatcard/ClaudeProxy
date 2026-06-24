# Gateway Architecture

## Purpose

This gateway accepts Anthropic-compatible requests from clients such as Claude Code, translates them into Gemini requests, executes them against a managed model/key pool, and translates responses back into Anthropic format.

The system is designed to:
- preserve Claude-compatible client behavior
- route work to the best Gemini-family model
- survive overload, rate limits, and model failures
- compact oversized conversations without losing active task context
- provide an admin dashboard for routing, keys, health, and runtime controls

## Top-Level Architecture

### 1. Client Compatibility Layer

Entry point:
- `app/api/v1/messages/route.ts`

Responsibilities:
- accepts Anthropic-style `/v1/messages` requests
- validates gateway tokens
- performs fast preflight for auth and routing
- supports both streaming and non-streaming responses
- returns Anthropic-compatible error and response shapes

### 2. Request Transformation Layer

Primary files:
- `lib/transformers/request.ts`
- `lib/transformers/tools.ts`
- `lib/transformers/repair.ts`
- `lib/transformers/optimizations.ts`

Responsibilities:
- converts Anthropic messages into Gemini `contents`
- converts system prompts into Gemini `systemInstruction`
- maps Claude tool schemas into Gemini function declarations
- repairs malformed tool arguments and tool payloads
- normalizes image, text, thinking, and tool-use content
- applies compaction and archived-tool-output hydration when needed

### 3. Response Transformation Layer

Primary files:
- `lib/transformers/response.ts`
- `lib/transformers/stream.ts`
- `lib/transformers/errors.ts`

Responsibilities:
- converts Gemini responses back into Anthropic-compatible JSON or SSE
- emits streaming events in Anthropic message order
- preserves tool-use IDs and tool result roundtrips
- handles thinking blocks and cross-model signature cleanup
- maps Gemini/provider failures into Anthropic-style API errors

### 4. Routing and Execution Layer

Primary files:
- `lib/model-router.ts`
- `lib/routing/task-router.ts`
- `lib/retry-engine.ts`
- `lib/gemini-adapter.ts`

Responsibilities:
- classifies the task type from request behavior
- maps Claude-facing models to Gemini-side routes
- supports Redis-backed runtime route overrides
- executes model calls with fallback and retry logic
- manages cache usage, signature stripping, and model-switch safety

### 5. Reliability and Recovery Layer

Primary files:
- `lib/recovery/overload-recovery.ts`
- `lib/context/emergency-compactor.ts`
- `lib/runtime/response-watchdog.ts`
- `lib/racing/key-racer.ts`
- `lib/racing/model-racer.ts`

Responsibilities:
- detects overload-like failures such as `429`, `503`, `529`, capacity errors, and timeouts
- cools down bad keys and rotates to fresh ones
- falls through model chains when a model becomes unhealthy
- compacts oversized context aggressively while preserving the opening prompt and active tail
- maintains long-running request budgets for agentic sessions
- supports optional parallel racing when enabled from admin settings

### 6. Persistence and State Layer

Primary files:
- `lib/redis.ts`
- `lib/cache-manager.ts`
- `lib/activity.ts`
- `lib/admin-settings.ts`
- `lib/auth.ts`

Stored state includes:
- provider key pool health and cooldowns
- gateway-issued user keys
- admin session cookies and session metadata
- model routing registry and sticky model hints
- emergency compaction state and summaries
- Gemini cache references
- usage, activity, metrics, and dashboard data
- runtime admin settings such as the racing toggle

### 7. Admin and Operations Layer

Primary surfaces:
- `app/dashboard/page.tsx`
- `app/dashboard/system/page.tsx`
- `app/dashboard/models/page.tsx`
- `app/dashboard/keys/page.tsx`
- `app/dashboard/user-keys/page.tsx`
- `app/api/admin/system/route.ts`
- `app/api/admin/session/*`

Responsibilities:
- admin authentication and session lifecycle
- provider key management
- gateway key issuance and revocation
- runtime route inspection and overrides
- live system controls and health reporting
- runtime feature flags such as parallel racing on/off
- overview visibility into current operating mode

## End-to-End Request Flow

### Non-Streaming Request

1. Client sends Anthropic-compatible request to `/api/v1/messages`.
2. Gateway extracts and validates the gateway token.
3. Gateway resolves a task-aware Gemini route.
4. Request transformer converts Anthropic content into Gemini format.
5. Retry engine executes the Gemini call using the routed model.
6. On failure, retry engine may:
   - compact context
   - rotate keys
   - switch models
   - drop bad cache references
   - strip invalid thought signatures
7. Response transformer converts Gemini output back into Anthropic JSON.
8. Metrics and activity logs are recorded asynchronously.

### Streaming Request

1. Gateway returns SSE headers immediately.
2. `transformStream()` performs the heavy execution path after the stream starts.
3. Ping events keep the stream alive.
4. Gemini deltas are translated into Anthropic SSE blocks.
5. Tool-use and thinking blocks are emitted in Claude-compatible order.
6. Stream closes cleanly with telemetry recorded at the end.

## Routing Model

Routing is task-aware, not purely alias-based.

Decision layers:
- client-requested Claude model alias
- runtime registry override from Redis
- task classification from message behavior
- sticky last-working model hints
- strict allowed-model pool enforcement

Task classes include:
- `CHAT`
- `HEALTH_CHECK`
- `LIGHT_CODING`
- `HEAVY_CODING`
- `REASONING`
- `COMPACTION`
- `WEB_SEARCH`

Important current behavior:
- trivial chat is routed to lite models first
- racing is disabled by default
- admin can enable or disable racing live from System Controls

## Overload Strategy

The overload strategy is intentionally layered.

### First-failure behavior

On the first overload-like signal the gateway can:
- mark the current model unhealthy for this request
- cool down the failing key
- rotate to a different key
- move to the next fallback model
- compact the middle of the conversation
- shorten later attempt budgets to avoid multi-minute stalls

### Compaction behavior

Two levels of compaction exist:
- synchronous overload compaction for immediate shrinkage
- emergency compaction with canonical future-state replacement

The synchronous overload compactor preserves:
- the original opening prompt
- the newest active tail

It removes:
- the least valuable middle turns

### Retry policy

The retry loop now favors simplicity:
- one pass through the resolved model chain
- shorter timeouts on continuation and fallback attempts
- faster failover under overload instead of repeatedly overchecking the same request surface

## Token, Tool, and Context Handling

### Tool roundtrip

The gateway preserves tool invocation continuity by storing:
- tool-use ID to Gemini tool name mapping
- thought signatures where relevant
- repaired argument payloads for safe client roundtrip

### Context management

The gateway manages context pressure through:
- rolling summaries
- archived large tool outputs
- emergency compaction state in Redis
- cache references for reusable prefixes

### Long-running sessions

The gateway now defaults to long-running request budgets:
- route max duration supports long agentic sessions
- watchdog request timeout defaults to 45 minutes

## Security Model

### Authentication

Two auth paths exist:
- gateway user tokens for client access
- admin auth for dashboard operations

Admin auth supports:
- bearer master key validation
- dashboard session cookies via Redis-backed session records

Gateway auth supports:
- issued user keys
- `MASTER_API_KEY` fallback for trusted client use

### Operational isolation

The gateway never executes client tools itself.
Tool execution remains client-side, and the gateway only translates the tool protocol and remembers mapping state between turns.

## Current Operational Controls

Admin-visible controls include:
- activate all provider keys
- clear failed key state
- flush Gemini cache references
- reset metrics
- clear activity log
- enable or disable parallel key/model racing

Overview visibility includes:
- key pool health
- active gateway keys
- current parallel racing status

## Main Files By Responsibility

### API
- `app/api/v1/messages/route.ts`
- `app/api/admin/system/route.ts`
- `app/api/admin/session/login/route.ts`
- `app/api/admin/session/me/route.ts`
- `app/api/admin/session/logout/route.ts`

### Routing and execution
- `lib/model-router.ts`
- `lib/routing/task-router.ts`
- `lib/retry-engine.ts`
- `lib/gemini-adapter.ts`

### Reliability
- `lib/recovery/overload-recovery.ts`
- `lib/context/emergency-compactor.ts`
- `lib/runtime/response-watchdog.ts`
- `lib/racing/key-racer.ts`
- `lib/racing/model-racer.ts`

### Transformation
- `lib/transformers/request.ts`
- `lib/transformers/response.ts`
- `lib/transformers/stream.ts`
- `lib/transformers/tools.ts`
- `lib/transformers/repair.ts`

### State and ops
- `lib/auth.ts`
- `lib/redis.ts`
- `lib/cache-manager.ts`
- `lib/activity.ts`
- `lib/admin-settings.ts`

### Dashboard
- `app/dashboard/page.tsx`
- `app/dashboard/system/page.tsx`
- `app/dashboard/models/page.tsx`
- `app/dashboard/keys/page.tsx`
- `app/dashboard/user-keys/page.tsx`

## Architecture Summary

This gateway is a compatibility, routing, and resilience layer between Anthropic-style clients and Gemini-family models. Its core design is:
- request translation at the edge of the system
- task-aware routing before execution
- Redis-backed runtime state and operational controls
- aggressive overload recovery with context preservation
- dashboard-driven operations for keys, routing, and runtime behavior

In practice, the gateway behaves as a durable execution coordinator rather than a simple protocol translator.
