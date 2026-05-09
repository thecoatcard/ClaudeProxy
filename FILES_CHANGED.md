# FILES_CHANGED.md

## New files

| File | Phase | Purpose |
|---|---|---|
| [lib/agent/retry-strategy.ts](lib/agent/retry-strategy.ts) | 3 | Failure classification + concrete alternative strategy generation. `classifyFailure(toolName, errorText)` returns `FailureClass`, `rootCause`, `prohibition`, `alternativeSteps`. Used to enrich loop-detector guidance. |
| [lib/agent/verification-engine.ts](lib/agent/verification-engine.ts) | 2 | Content-based tool-result verdicts (`success` / `failure` / `uncertain`) without filesystem access. Driven by error-pattern matching and tool-family heuristics. |
| [lib/agent/path-guard.ts](lib/agent/path-guard.ts) | 4 | Structural path inspection in `tool_use.input` values. Detects traversal (`../`), mixed separators, null bytes, empty paths, and shell metacharacters. |
| [lib/agent/spec-validator.ts](lib/agent/spec-validator.ts) | 1 | Numbered/bulleted requirement extraction from system text + tracking against successful tool calls in message history. |
| [lib/agent/completion-gate.ts](lib/agent/completion-gate.ts) | 5 | Detects premature "done/complete/finished" claims in the last assistant turn and validates them against the tool-result record. |
| [lib/agent/behavior-auditor.ts](lib/agent/behavior-auditor.ts) | all | Orchestrator: runs all checks in priority order, returns combined `guidance` string for `systemInstruction`. |
| [lib/transformers/loop-detector.ts](lib/transformers/loop-detector.ts) | 3 (prev) | Added in previous audit. Detects ≥2 consecutive identical failed tool calls by stable input signature. |
| [tests/behavioral-tests.ts](tests/behavioral-tests.ts) | 7 | 54 behavioral tests across 9 suites using `node:test` + `tsx`. |
| [prompts-upgrade.md](prompts-upgrade.md) | 6 | Documents all triggered guidance text with before/after behavior comparison. |

## Modified files

| File | Change |
|---|---|
| [lib/transformers/request.ts](lib/transformers/request.ts) | Replaced `detectFailureLoop` import with `runBehaviorAudit`. Single call replaces previous loop-detector call; awaits result and appends combined guidance to `systemText`. |

## Files audited but not changed

| File | Status |
|---|---|
| [lib/transformers/response.ts](lib/transformers/response.ts) | No changes needed — tool roundtrip and repair correct. |
| [lib/transformers/stream.ts](lib/transformers/stream.ts) | No changes needed — SSE sequence correct. |
| [lib/transformers/tools.ts](lib/transformers/tools.ts) | No changes needed — schema conversion correct. |
| [lib/transformers/repair.ts](lib/transformers/repair.ts) | No changes needed — coercion complete. |
| [lib/retry-engine.ts](lib/retry-engine.ts) | No changes needed — fallback/key-rotation logic correct. |
| [app/api/v1/messages/route.ts](app/api/v1/messages/route.ts) | No changes needed — routing correct. |

## What was NOT built (and why)

| Requested | Decision |
|---|---|
| Filesystem-based `VerificationEngine` (file exists?) | Impossible on Edge runtime — implemented content-based equivalent instead. |
| `PathGuard` calling `path.resolve()` / checking parent dir via fs | Impossible on Edge runtime — implemented structural path heuristics instead. |
| Tool execution runtime | Out of scope — the gateway is a protocol translator, not an executor. |
| Sandbox / container mounts | Out of scope — same reason. |
| Shell cwd propagation | Out of scope — same reason. |
