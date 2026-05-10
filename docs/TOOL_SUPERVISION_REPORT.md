# Tool Supervision Report

## Overview

This report documents the 8-phase tool behavior hardening initiative that transforms the agent's tool execution model to match Claude Code's production-grade tool flow. The system now detects edit loops, classifies failures, applies recovery strategies, and enforces strategy changes before infinite loops can form.

---

## Phase 1 — Tool Loop Stagnation Detection

**File**: `lib/transformers/loop-detector.ts`  
**Export**: `detectEditStagnation(messages): EditStagnationResult`

The loop detector now performs a second pass over conversation history to identify two stagnation patterns:

### Pattern A: READ_EDIT_LOOP
Triggered when a file is read and then edited unsuccessfully at least twice. This matches the classical Claude Code anti-pattern of `Read → Edit fail → Read → Edit fail`.

### Pattern B: REPEATED_EDIT_FAIL
Triggered when consecutive edit failures occur on the same file without any intermediate read or strategy change.

Both patterns emit the `[TOOL_LOOP_STAGNATION]` guidance marker for downstream consumers.

---

## Phase 2 — Edit Failure Classifier

**File**: `lib/tools/edit-failure-classifier.ts`  
**Export**: `classifyEditFailure(toolResultContent): EditFailureClassification`

Pure classification of edit tool failures from `tool_result` content strings. No I/O, edge-runtime safe.

### Failure Types (ordered by specificity)

| Type | Confidence | Trigger Keywords |
|------|-----------|-----------------|
| `MULTIPLE_MATCHES` | high | "multiple matches found", "found N matches" |
| `WHITESPACE_MISMATCH` | high | "whitespace mismatch", "indentation differ", "tabs vs spaces" |
| `EXACT_MATCH_FAILURE` | high | "old_string not found", "exact match not found" |
| `FILE_CHANGED` | high | "file modified since", "content changed since" |
| `FILE_CHANGED` | medium | "no such file", "enoent" |
| `NO_MATCH_FOUND` | medium | "no match", "not found", "could not locate" |
| `UNKNOWN` | low | fallback |

Each classification includes a `recoveryHint` guiding the next action.

### Additional Exports

- `isEditTool(name)` / `isReadTool(name)` — tool name classification
- `extractFilePath(toolInput)` — extracts path from any tool input schema
- `normalizePath(p)` — backslash→slash, lowercase, trim trailing slash
- `normalizeLineEndings(text)` — CRLF/CR → LF (Phase 8)

---

## Phase 3 — Claude Code-Like Edit Recovery

**File**: `lib/tools/edit-recovery.ts`  
**Export**: `buildEditRecoveryGuidance(attemptCount, failureType, filePath, oldStringLength?): EditRecoveryGuidance`

A three-step recovery protocol modeled after Claude Code's edit retry behavior:

| Attempt | Step | Description |
|---------|------|-------------|
| 1 | `REREAD_AND_RETRY` | Re-read file, re-extract exact text, retry with corrected content |
| 2 | `WRITE_FALLBACK` | Switch to Write strategy — overwrite the file entirely |
| 3+ | `ESCALATE` | `MANDATORY` strategy change — no more edit retries |

The guidance includes the `[EDIT_RECOVERY]` marker and specific instructions based on the failure type. Maximum 2 edit retries before ESCALATE.

---

## Phase 4 — Write Fallback

**File**: `lib/tools/edit-recovery.ts`  
**Export**: `buildWriteFallbackHint(fileRef, failureType): string`

When an edit fails twice, recovery guidance pivots to a Write strategy. The hint:
- Names the file to write
- Explains why Write is safer (avoids old_string matching issues)
- Prohibits a third edit attempt
- Includes the `[EDIT_RECOVERY]` marker

---

## Phase 5 — Patch Granularity Check

**File**: `lib/tools/edit-recovery.ts`  
**Export**: `checkPatchGranularity(oldStringLength): string`  
**Constant**: `LARGE_PATCH_THRESHOLD = 400`

When the `old_string` block exceeds 400 characters, recovery guidance on the first attempt includes a warning to split the patch into smaller, more precise chunks. Returns an empty string when below the threshold.

---

## Phase 6 — Tool Failure Memory

**File**: `lib/tools/tool-failure-memory.ts`  
**Redis Key**: `tool:fail:{sessionKey}:{stableHash(toolName:filePath)}`  
**TTL**: 3600 seconds

Redis-backed tracking of tool failures per (session, tool, file) triple.

### Key Functions

| Function | Purpose |
|----------|---------|
| `recordToolFailure(session, tool, file, reason)` | Increment count, update lastReason |
| `getToolFailureCount(session, tool, file)` | Return failure count (0 if none) |
| `getToolFailureRecord(session, tool, file)` | Return full record or null |
| `hasIdenticalRecentFailure(session, tool, file, reason)` | Detect repeated identical failure |
| `clearToolFailures(session, tool, file)` | Remove failure record |

All functions swallow errors — Redis failures are non-critical.

### Integration in request.ts

After behavior audit, the request transformer fires-and-forgets `recordToolFailure` for every edit tool failure found in the last user message's `tool_result` blocks.

---

## Phase 7 — Loop Breaker

**File**: `lib/agent/behavior-auditor.ts`

When `detectEditStagnation` reports `failureCount >= 3`, the behavior auditor injects an additional hard-stop guidance block:

```
[LOOP_BREAKER] MANDATORY: Change strategy now. DO NOT make another identical edit attempt. Switch to Write, Insert, or ask for user guidance.
```

The `buildEditRecoveryGuidance` function also returns `ESCALATE` with `MANDATORY` language at attempt 3+, ensuring both the auditor and recovery planner enforce the same boundary.

---

## Phase 8 — Windows Path Safety

**File**: `lib/tools/edit-failure-classifier.ts`, `lib/transformers/loop-detector.ts`

- `normalizeLineEndings(text)`: converts `\r\n` and standalone `\r` to `\n` before classification and signature computation
- `normalizePath(p)`: converts backslashes to forward slashes, lowercases, trims trailing slash
- Loop detector signature computation normalizes both backslashes and CRLF, so Windows paths (`C:\src\file.ts`) are treated the same as POSIX paths (`c:/src/file.ts`)

This ensures that CRLF-terminated error messages and Windows absolute paths do not create false negatives in loop detection.

---

## Modified Files

| File | Change |
|------|--------|
| `lib/transformers/loop-detector.ts` | Added `detectEditStagnation`, Phase 8 normalization |
| `lib/agent/behavior-auditor.ts` | Phase 0 stagnation check, `[LOOP_BREAKER]` injection |
| `lib/transformers/request.ts` | Fire-and-forget `recordToolFailure` after audit |

## New Files

| File | Purpose |
|------|---------|
| `lib/tools/edit-failure-classifier.ts` | Pure failure classification (Phase 2, 8) |
| `lib/tools/edit-recovery.ts` | Recovery strategy guidance (Phase 3, 4, 5) |
| `lib/tools/tool-failure-memory.ts` | Redis failure tracking (Phase 6) |

## Test Files

| File | Tests |
|------|-------|
| `tests/edit-failure-classifier.test.ts` | 48 tests |
| `tests/edit-recovery.test.ts` | 36 tests |
| `tests/tool-loop-detector.test.ts` | 22 tests |
| `tests/tool-failure-memory.test.ts` | 19 tests |

**Total new tests: 125**  
**Full suite: 929 passing, 0 failing**
