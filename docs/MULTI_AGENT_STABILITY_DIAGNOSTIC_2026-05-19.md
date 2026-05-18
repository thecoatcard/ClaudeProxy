# Multi-Agent Stability Diagnostic and Hardening Report

Date: 2026-05-19
Scope: orchestration, resume continuity, race behavior, timeout/cancellation, checkpoint durability

## 1) Deep Diagnostic Findings

### A. Context and task continuity failures
1. Resume logic re-executed already-completed tasks when no pending tasks existed.
2. Resume logic executed only pending/failed tasks without seeding completed dependencies, causing dependency deadlocks/skips.
3. Merge used only in-memory scheduler outputs from the current run, so prior completed work was dropped during resume.
4. Finalization forced all tasks to COMPLETED, masking failures and causing false progress signals.

### B. Multi-agent orchestration consistency risks
5. Dedup reuse path did not enforce loop-entry guard, allowing repeated re-entry attempts.
6. Fingerprint registration was non-atomic (no NX behavior), enabling concurrent duplicate orchestrations.

### C. Free-tier and low-rate limit inefficiencies
7. Key/model race losers were not actually canceled (AbortControllers were created but not wired), causing quota burn and backend contention.
8. Timeout wrapper did not abort active upstream fetches in retry loop, so timed-out attempts could continue in background.

### D. Reliability verification gap
9. Watchdog timeout test leaked open timer handles under detectOpenHandles, reducing confidence in CI leak detection.

## 2) Implemented Hardening

### A. Durable shared memory and checkpointing
- Added persisted per-task execution snapshots in `lib/agent/subagent-memory.ts`:
  - `execution: SubagentExecutionSnapshot | null` on each task
  - new `saveSubagentExecution(taskId, snapshot)` API
- Subagent executor now persists execution checkpoints (success/failure) with output, tokens, latency, retries.

### B. Deterministic resume and merge reconstruction
- `scheduleSubagentTasks` now supports resume bootstrap options:
  - `preCompletedTaskIds`
  - `preResolvedOutputs`
- Dependency readiness now treats external pre-completed deps as satisfied.
- Resume path now:
  - reuses persisted completed outputs
  - resumes `RUNNING` tasks as recoverable
  - avoids re-running completed tasks
  - merges using persisted snapshots + new outputs
- Merge engine now reconstructs results from persisted snapshots when scheduler outputs are absent.

### C. Correct final state and failure signaling
- Finalization now reads live task states and snapshots before state transition.
- Failed task evidence now transitions orchestration to `FAILED` instead of force-closing as `COMPLETED`.

### D. Loop guard and dedup safety
- Dedup reuse path now enforces `checkAndIncrementLoopCount` before reuse.
- Fingerprint write now uses NX semantics and maintains TTL.
- Fingerprint registration now returns canonical parent, allowing concurrent dedup race reconciliation.

### E. Free-tier protection and cancellation correctness
- `callGemini` now supports external abort signal and configurable timeout.
- Retry engine now passes abort controller through `withTimeout` and `callGemini`, ensuring timed-out attempts are canceled.
- Key and model racers now wire abort signals to each call and abort losers immediately.
- Model racing now prefers distinct keys and avoids duplicate same-key fanout under constrained pools.

### F. Timeout/watchdog reliability
- `withTimeout` now unrefs timer handles and guards against double-settle.
- Watchdog test updated to unref intentionally slow timer.

## 3) Verification Added

New/extended tests:
- `tests/orchestrator-resume-continuity.test.ts`
  - verifies completed dependency reuse
  - verifies no re-run when all tasks already completed
- `tests/orchestrator-loop-guard-enforcer.test.ts`
  - verifies third dedup re-entry is blocked by loop guard
- `tests/subagent-scheduler.test.ts`
  - verifies pre-completed dependency bootstrap in resume mode
- `tests/subagent-merge.test.ts`
  - verifies merge/validation from persisted snapshots
- `tests/response-watchdog.test.ts`
  - timer handle leak fixed for detectOpenHandles

Test results:
- `npm test`: 86/86 suites passed, 958/958 tests passed
- `npm test -- --detectOpenHandles`: 86/86 suites passed, no open-handle leak reported

## 4) Outcome vs Required Stability Goals

- Reliable context persistence: implemented via execution snapshots in subagent memory.
- Stable multi-agent coordination: resume bootstrap and canonical dedup parent handling added.
- Shared memory/state tracking: persisted execution checkpoints and merged resume reconstruction.
- Deterministic workflows: pre-completed dependency seeding + failure-aware finalization.
- Error recovery/retry handling: abort-propagated timeout and loser cancellation.
- Task checkpointing: per-task execution checkpoints (output/tokens/retries/error).
- Orchestration logging consistency: explicit loop-block and failure-state transitions.
- Efficient token/context use under free-tier limits: removed duplicate fanout waste and stale reruns.

