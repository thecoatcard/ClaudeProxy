# Gateway Bug Task Plan — BUG_TASK_PLAN.md

**Priority order:** CRITICAL → HIGH → MEDIUM → LOW

---

## Task 1

**Bug:** BUG-001 — Prompt Injection via "Superpower Permission Bypass"  
**Fix:** Remove the hardcoded permission-bypass block from `tryOptimizations()`. This entire branch is a security anti-pattern incompatible with a translator-layer gateway.  
**Files:** `lib/transformers/optimizations.ts`  
**Tests:** `tests/behavioral-tests.ts` — add injection-attempt test  

---

## Task 2

**Bug:** BUG-002 — SSRF via Agentic Web Fetch  
**Fix:** Remove the `web_search` and `web_fetch` local-execution optimization blocks from `tryOptimizations()`. The gateway is a translator layer and must not execute HTTP requests on behalf of user-controlled tool schemas. The `performWebSearch` and `performWebFetch` helper functions can be removed entirely.  
**Files:** `lib/transformers/optimizations.ts`  
**Tests:** Verify optimizations.ts no longer references `fetch()` outside of its gateway responsibilities  

---

## Task 3

**Bug:** BUG-003 — Infinite Loop / Duplicate Tool Emission in Stream Action Recovery  
**Fix:** In `stream.ts` action recovery `while(true)` loop, track a `searchOffset` variable. Pass `cleanedText.slice(searchOffset)` to `recoverActionText`. Adjust returned `start`/`end` positions by adding `searchOffset` before using them. Advance `searchOffset = absEnd` after each recovery. This mirrors how `response.ts` slices `cleanedText` but without breaking the streaming position tracking.  
**Files:** `lib/transformers/stream.ts`  
**Tests:** `tests/tool-structure.test.ts` — add stream action recovery no-duplicate test  

---

## Task 4

**Bug:** BUG-004 — anyOf with Null Type Loses Nullable  
**Fix:** In `convertSchema()`, before picking the first branch from `oneOf`/`anyOf`, scan all branches for a `null` type entry. If found, set `nullable: true` on the merged schema before recursing.  
**Files:** `lib/transformers/tools.ts`  
**Tests:** `tests/tool-structure.test.ts` — add anyOf nullable preservation test  

---

## Task 5

**Bug:** BUG-005 — Interactive CLI Commands Not Detected  
**Fix:** Create `lib/agent/interactive-command-guard.ts` with:  
- `INTERACTIVE_CLI_PATTERNS` array detecting `shadcn`, `prisma init`, `firebase init`, `create-t3-app`, `supabase init`, and other wizard CLIs  
- `detectInteractiveCommand(command)` returning detection result with recommended non-interactive flags  
- `buildInteractiveGuidance(detections)` producing system instruction fragment  
Wire into `runBehaviorAudit()` in `lib/agent/behavior-auditor.ts`.  
**Files:** `lib/agent/interactive-command-guard.ts` (new), `lib/agent/behavior-auditor.ts`  
**Tests:** `tests/interactive-command-guard.test.ts` (new)  

---

## Task 6

**Bug:** BUG-006 — Stream Missing Incomplete Open Blocks at Error Exit  
**Fix:** In the outer `catch` block of `transformStream`, before emitting the `error` and `message_stop` events, emit `content_block_stop` for any open `inContentBlock`, `inToolCall`, or `inThinking` state. Include a `message_delta` with stop_reason before `message_stop`.  
**Files:** `lib/transformers/stream.ts`  
**Tests:** `tests/behavioral-tests.ts` — add stream error cleanup test  

---

## Task 7

**Bug:** BUG-007 — Completion Gate Skips Tool-Call-Only Assistant Turns  
**Fix:** Change `detectPrematureCompletion` to scan backwards through assistant messages until it finds one with actual text content (not just tool_use blocks), up to a depth of 5 messages. This ensures completion claims in "text→tool" patterns are caught.  
**Files:** `lib/agent/completion-gate.ts`  
**Tests:** `tests/behavioral-tests.ts` — add test for claim-then-tool pattern  

---

## Task 8

**Bug:** BUG-008 — topK Clamped at 40  
**Fix:** Increase the topK cap from 40 to 64 (Gemini 2.5's documented maximum). For older/smaller models, keep at 40. Use a per-model map.  
**Files:** `lib/transformers/request.ts`  
**Tests:** Type-check only  

---

## Task 9

**Bug:** BUG-009 — v1 Compaction Sentinel Not Hydrated  
**Fix:** Add `SUMMARY_SENTINEL_V1 = '<!-- compacted:v1 -->'` check in `hydrateCompactedMarkers`. For v1 messages, attempt to parse the range_id the same way and load from Redis.  
**Files:** `lib/compactor/ai-compactor.ts`  
**Tests:** `tests/context-compaction.test.ts`  

---

## Task 10

**Bug:** BUG-010 — Duplicate stableHash with Overflow Risk  
**Fix:** Extract a single `stableHash` using `Math.imul` for safe 32-bit multiplication into a shared `lib/utils/hash.ts`. Update both callers.  
**Files:** `lib/utils/hash.ts` (new), `lib/transformers/request.ts`, `lib/compactor/ai-compactor.ts`  
**Tests:** Unit test hash collision resistance  

---

## Task 11

**Bug:** BUG-011 — Loop Detector Misses Alternating Failures  
**Fix:** In `detectFailureLoop`, after the consecutive-run check, add a secondary check for non-consecutive repetitions: if the same failure signature appears ≥ `policy.minRepeats` times anywhere in the last N pairs (regardless of ordering), emit guidance.  
**Files:** `lib/transformers/loop-detector.ts`  
**Tests:** `tests/behavioral-tests.ts` — add alternating-failure test  

---

## Task 12

**Bug:** BUG-012 — Process Supervisor Guidance Fires for STARTED Processes  
**Fix:** In `assessLongRunningProcessHistory`, return `guidance: ''` when `analysis.state === 'STARTED'` (process successfully running, no further intervention needed). Retain guidance only for `FAILED` and `UNKNOWN` states.  
**Files:** `lib/agent/process-supervisor.ts`  
**Tests:** `tests/process-supervisor.test.ts` — add STARTED-no-guidance test  

---

## Task 13 (LOW)

**Bug:** BUG-013 — metadatapersist Retry Without Backoff  
**Fix:** Add a 100ms delay between retries in `setexBestEffort`.  
**Files:** `lib/transformers/metadata-persist.ts`  
**Tests:** N/A (trivial)  

---

## Task 14 (LOW — Skip unless trivial)

**Bug:** BUG-014 — Shell Environment Returns 'unknown' Too Often  
**Status:** Skip — requires cross-turn state tracking, outside scope.

---

## Task 15 (LOW — Skip)

**Bug:** BUG-015 — Web Search HTML Parsing Fragile  
**Status:** Moot after Task 2 (web_fetch/search removed from optimizations).

---

## Implementation Priority

| Task | Bug | Severity | Effort | Risk |
|------|-----|----------|--------|------|
| Task 1 | BUG-001 | CRITICAL | Trivial | None |
| Task 2 | BUG-002 | CRITICAL | Low | None |
| Task 3 | BUG-003 | CRITICAL | Low | Low |
| Task 4 | BUG-004 | HIGH | Low | Low |
| Task 5 | BUG-005 | HIGH | Medium | Low |
| Task 6 | BUG-006 | HIGH | Low | None |
| Task 7 | BUG-007 | HIGH | Low | Low |
| Task 8 | BUG-008 | MEDIUM | Trivial | None |
| Task 9 | BUG-009 | MEDIUM | Low | Low |
| Task 10 | BUG-010 | MEDIUM | Low | Low |
| Task 11 | BUG-011 | MEDIUM | Medium | Medium |
| Task 12 | BUG-012 | MEDIUM | Trivial | None |
| Task 13 | BUG-013 | LOW | Trivial | None |
