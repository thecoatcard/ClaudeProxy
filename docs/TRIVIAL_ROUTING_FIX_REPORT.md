# Trivial Routing Fix Report

## Problem

Simple greetings like "hi" were being treated as COMPLEX tasks, triggering:
- Full orchestrator pipeline
- Subagent assignment and task decomposition
- Heavy model routing (gemini-2.5-flash)
- Overload failures and 26s latency

## Root Causes

1. **`extractText()` joins system prompt + user message** — `^(hi|hello)$` regex never matched because the string was `"You are a coding assistant... hi"`, not `"hi"`
2. **No intent detection** — No pre-check to identify greetings before complexity classification
3. **HEALTH_CHECK regex too broad** — `/health|status|heartbeat|ping/` matched greetings like "ping" and "status"
4. **No CHAT task type** — Task router had no lightweight routing category; everything defaulted to HEAVY_CODING
5. **Overload backoff too slow** — 2s/5s/10s delays caused ~26s worst-case latency

## Fixes Applied

### Part 1 — Intent Detector (NEW: `lib/agent/intent-detector.ts`)
- Extracts ONLY the user message (ignores system prompt)
- Classifies: `TRIVIAL_CHAT` | `QUESTION` | `TASK`
- Patterns: greetings, acknowledgments, single-word responses, empty messages
- `shouldSkipOrchestrator()` returns true for TRIVIAL_CHAT and QUESTION

### Part 2 — Complexity Detector Fix (`lib/agent/task-complexity.ts`)
- Intent check runs FIRST (on user message only)
- TRIVIAL_CHAT → immediate TRIVIAL classification (no orchestrator)
- Tool count > 0 overrides TRIVIAL_CHAT (real work with tools)
- Existing TRIVIAL patterns also run against user message only (not system prompt)

### Part 3 — Orchestrator Guard (`lib/agent/orchestrator-enforcer.ts`)
- Added `shouldSkipOrchestrator()` check before orchestrator pipeline
- TRIVIAL_CHAT/QUESTION → skip orchestrator entirely (no subagents, no decomposition)
- Explicit overrides (`"use subagents"`) still force orchestrator

### Part 4 — Task Router (`lib/routing/task-router.ts`)
- Added `CHAT` task type with `CHAT_CHAIN = ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest']`
- CHAT detected via intent detector (runs before health check)
- HEALTH_CHECK regex tightened: now requires explicit health keywords (`check health`, `health check`, `heartbeat`, `diagnostic`, `verify gateway`) — no longer matches "ping" or "status" alone

### Part 5 — Fast Overload Failover (`lib/recovery/overload-recovery.ts`)
- Backoff reduced: 2s/5s/10s → 500ms/1s/2s
- Combined with maxRetries cap (12), worst case: ~6s (was ~26s)
- Jitter reduced from 500ms to 300ms

## Files Changed

| File | Action | Changes |
|------|--------|---------|
| `lib/agent/intent-detector.ts` | NEW | Intent detector with TRIVIAL_CHAT/QUESTION/TASK classification |
| `lib/agent/task-complexity.ts` | MODIFIED | Added intent pre-check, imports, user message extraction |
| `lib/agent/orchestrator-enforcer.ts` | MODIFIED | Added intent guard before orchestrator pipeline |
| `lib/routing/task-router.ts` | MODIFIED | Added CHAT type, tightened HEALTH_CHECK regex |
| `lib/recovery/overload-recovery.ts` | MODIFIED | Reduced overload backoff from 2s/5s/10s to 500ms/1s/2s |
| `tests/intent-detector.test.ts` | NEW | 30 tests for intent detection |
| `tests/trivial-routing.test.ts` | NEW | 14 tests for CHAT routing |
| `tests/orchestrator-guard.test.ts` | NEW | 9 tests for orchestrator guard |
| `tests/overload-recovery.test.ts` | MODIFIED | Updated backoff expectations |

## Test Results

- 376 tests passing across 36 suites
- 3 new test files: 53 new tests
- 0 regressions

## Success Criteria

- [x] Greetings classified correctly (TRIVIAL_CHAT)
- [x] Orchestrator skipped for trivial chat
- [x] No subagents for greetings
- [x] Lite models used for trivial chat (gemini-2.5-flash-lite)
- [x] Overload latency reduced (26s → ~6s worst case)
- [x] Health-check misclassification fixed (no more "ping" → HEALTH_CHECK)
