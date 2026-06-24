# Gateway Stabilization Report

## Executive Summary

The gateway request path has been stabilized so Coatcard AI Magic behaves as an Anthropic-compatible gateway instead of attempting to become a second agent runtime in front of Claude Code.

The live `/api/v1/messages` path now performs only gateway responsibilities: authentication, model routing, request transformation, optional context compaction, key selection, retry/fallback, streaming/non-streaming response transformation, telemetry, and activity logging. It no longer prepares, starts, or finalizes subagent orchestration for user requests.

The legacy orchestrator module remains available only behind `ENABLE_GATEWAY_ORCHESTRATOR=true` for isolated tests or future internal experiments. The default production behavior is direct pass-through orchestration by Claude Code.

## Root Causes Found

### 1. Gateway Was Acting Like an Agent Runtime

The messages route called `prepareOrchestration()`, injected coordinator instructions, marked tasks running, and finalized orchestration around every non-trivial request. That created hidden subagent state and extra model work before Claude Code received the answer.

Fix: removed orchestration calls from `/api/v1/messages`. The route now sends the user's request through a single gateway model pipeline.

### 2. Legacy Complexity Classifier Forced Orchestration

`classifyComplexity()` treated normal, complex, and multi-stage prompts as `orchestratorRequired=true`. This was wrong for a gateway: Claude Code is already the agent and should decide tool/subagent use.

Fix: `orchestratorRequired` is now gated by `ENABLE_GATEWAY_ORCHESTRATOR=true`. Default is always `false` except trivial remains false as before.

### 3. Parallel Key/Model Racing Caused Duplicate Upstream Calls

The retry engine raced multiple keys and multiple models by default. That could send duplicate Gemini requests for a single Claude Code turn, raising cost and contention.

Fix: key racing defaults to one key (`KEY_RACE_COUNT=1`) and model racing defaults off (`MODEL_RACE_ENABLED=true` required). Serial retry/fallback remains available.

### 4. Ordinary Analysis Prompts Could Route to Gemma

The task router sent requests containing words such as `analyze`, `plan`, `reason`, or `investigate` to the Gemma reasoning chain. Claude Code requests often contain those words as normal agent work.

Fix: normal user requests no longer route to Gemma due to generic reasoning keywords or thinking mode. Gemma remains for explicit gateway-internal helper calls such as compaction helpers.

### 5. Compaction Could Call Internal Models Too Aggressively

Compaction could trigger due to message count alone, which meant moderate conversations might produce internal summary work even without token pressure.

Fix: compaction now triggers only when estimated tokens exceed the configured budget. Defaults were raised to `180000` tokens for regular models and `120000` for lite models.

### 6. Dashboard Pages Duplicated Auth Checks

Individual dashboard pages repeatedly called `/api/auth/me` even though the layout already had auth state.

Fix: all dashboard pages now consume `AuthProvider` / `useAuth()` from the layout context.

## Current Gateway Flow

1. Request enters `POST /api/v1/messages`.
2. The route extracts the Bearer token and parses the Anthropic-compatible request body.
3. Auth and model routing run in parallel:
   - `validateUserKey(token)` validates the gateway key.
   - `getModelMapping(model, requestBody)` chooses the Gemini route.
4. Request transformation runs:
   - Hydrates compacted summary markers.
   - Loads rolling context metadata.
   - Evaluates token-pressure compaction.
   - Runs the behavior audit.
   - Evaluates operational memory guidance.
   - Loads tool metadata for thought signatures and restored tool names.
   - Converts Anthropic messages/tools to Gemini format.
5. If web search is requested and available, the route calls `runWithWebSearch()`.
6. Otherwise the retry engine calls Gemini:
   - Key racing is skipped by default.
   - Model racing is skipped by default.
   - A single model call is made with timeout protection.
   - On 429/500/503 or recoverable backend failures, the serial fallback logic rotates key/model as needed.
7. The response transformer converts Gemini output back to Anthropic-compatible response JSON or SSE chunks.
8. Metrics, token counts, latency, and activity logs are recorded.
9. The final response returns to Claude Code.

## Timing Instrumentation Added

Request-scoped structured events now include durations for:

- Auth validation (`AUTH`)
- Model routing (`ROUTING`)
- Preflight (`ACTIVITY`)
- Compacted marker hydration (`RETRIEVAL`)
- Context metadata lookup (`RETRIEVAL`)
- Context compaction evaluation (`COMPACTION`)
- Behavior audit (`SYSTEM`)
- Operational memory evaluation (`MEMORY`)
- Tool metadata lookup (`MEMORY`)
- Request transformation (`ACTIVITY`)
- Key race skipped/completed (`KEY_RACE`)
- Model race skipped/completed (`MODEL_RACE`)
- Gemini model call latency (`MODEL_CALL`)
- Stream completion (`STREAM`)
- Request completion (`ACTIVITY`)

These events appear in the observability dashboard and can be filtered by category.

## Responsibility Boundaries

### Claude Code Owns

- Agent planning
- Tool selection
- Subagent/delegation decisions
- Multi-step task execution
- User-facing reasoning and edits

### Gateway Owns

- Auth
- Anthropic-to-Gemini API adaptation
- Model alias routing
- Key health, cooldown, and fallback
- Token-pressure compaction
- Response/stream conversion
- Activity, metrics, and observability

### Gemma Owns

- Explicit internal helper work only, such as compaction/reasoning helpers when called directly by gateway modules
- Not ordinary Claude Code user request planning by keyword

## Validation

- `npx tsc --noEmit`: pass
- Focused impacted Jest suites: pass
  - `task-complexity.test.ts`
  - `orchestrator-guard.test.ts`
  - `orchestrator-enforcer.test.ts`
  - `subagent-retry.test.ts`
  - `token-pressure-compaction.test.ts`
  - `trivial-routing.test.ts`
  - `key-racer.test.ts`
  - `model-racer.test.ts`
- Full Jest run: 429 tests passed, with 23 suite-level failures unrelated to this stabilization path. Remaining failures are existing harness/test debt: empty test files, `.js` imports for TypeScript modules, nanoid ESM handling, Redis test module resolution, and old node:test expectations.
- `npm run lint`: fails on existing repository-wide lint debt (`no-explicit-any`, `no-require-imports`, unused variables). No TypeScript build errors remain.

## Main Files Changed

- `app/api/v1/messages/route.ts`
- `lib/retry-engine.ts`
- `lib/transformers/request.ts`
- `lib/transformers/stream.ts`
- `lib/transformers/compaction.ts`
- `lib/agent/task-complexity.ts`
- `lib/agent/orchestrator-enforcer.ts`
- `lib/routing/task-router.ts`
- `lib/logging/event-logger.ts`
- `lib/logging/timeline-builder.ts`
- Dashboard pages under `app/dashboard/`

## Operational Defaults

| Setting | Default | Effect |
|---|---:|---|
| `ENABLE_GATEWAY_ORCHESTRATOR` | unset / false | Gateway never creates subagents |
| `KEY_RACE_COUNT` | `1` | Single upstream call per attempt |
| `MODEL_RACE_ENABLED` | false | No duplicate model fanout |
| `CONTEXT_COMPACTION_TARGET_TOKENS` | `180000` | Compact only under high token pressure |
| `CONTEXT_COMPACTION_TARGET_TOKENS_LITE` | `120000` | Higher threshold for lite models than before |

## Remaining Risks

- The repository still contains legacy orchestrator and subagent modules. They are default-off but should be treated as experimental/legacy until either removed or moved behind a separate internal route.
- Full-suite test health is obscured by mixed Jest/node:test patterns and stale `.js` imports. Fixing the test harness would make future regressions much easier to detect.
- Lint is not yet useful as a gate because existing code has hundreds of rule violations.