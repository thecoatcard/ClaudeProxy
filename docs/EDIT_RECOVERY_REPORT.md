# Edit Recovery Report

## Overview

This report documents the Claude Code-like edit recovery pipeline implemented in Phases 3, 4, and 5 of the tool behavior hardening initiative. The system provides structured, escalating recovery guidance when edit tools fail, preventing infinite retry loops and guiding the agent toward successful strategies.

---

## Architecture

```
Edit Tool Failure
       │
       ▼
classifyEditFailure()          [Phase 2 — edit-failure-classifier.ts]
       │
       ▼ EditFailureType
buildEditRecoveryGuidance()    [Phase 3/4/5 — edit-recovery.ts]
       │
       ├── attempt 1 → REREAD_AND_RETRY
       │      └── large patch? → checkPatchGranularity() hint
       ├── attempt 2 → WRITE_FALLBACK
       └── attempt 3+ → ESCALATE (MANDATORY)
```

---

## Phase 3 — REREAD_AND_RETRY Protocol

**Triggered on**: First edit failure (`attemptCount === 1`)

### Steps Injected into Guidance

1. **Re-read the file** — fetch current content before attempting any edit
2. **Re-extract exact text** — find the literal string in the file that must be replaced
3. **Retry with corrected content** — apply the edit using the freshly extracted text

This mirrors Claude Code's behavior of not relying on stale assumptions about file content.

### Failure-Specific Hints

| Failure Type | Hint Injected |
|-------------|--------------|
| `EXACT_MATCH_FAILURE` | Check indentation and whitespace in old_string |
| `WHITESPACE_MISMATCH` | Normalize tabs/spaces; match file exactly |
| `MULTIPLE_MATCHES` | Make old_string more specific (include more context lines) |
| `FILE_CHANGED` | Re-read first — file was modified since last read |
| `NO_MATCH_FOUND` | Verify the target text still exists in the file |
| `UNKNOWN` | Re-read and verify the exact content |

### Guidance Marker

All REREAD_AND_RETRY guidance includes the `[EDIT_RECOVERY]` marker for observability and filtering.

---

## Phase 4 — WRITE_FALLBACK

**Triggered on**: Second edit failure (`attemptCount === 2`)

### Rationale

When the same file fails to edit twice, the `old_string` matching approach is no longer reliable. The Write strategy overwrites the file entirely, bypassing match-based editing.

### Guidance Content

```
[EDIT_RECOVERY] Edit has failed twice on <file>. 
Switch to Write strategy: read the full current content, apply changes in memory, 
then write the complete file. Do not attempt a third edit on this file.
```

The hint:
- Names the specific file
- Explains the reason for switching
- Prohibits a third edit attempt
- Adapts the explanation based on failure type

### Export: `buildWriteFallbackHint(fileRef, failureType)`

Used both internally (by `buildEditRecoveryGuidance` at attempt 2) and externally for callers that need the hint without the full guidance object.

---

## Phase 5 — Patch Granularity Check

**Triggered on**: First attempt when `old_string.length > LARGE_PATCH_THRESHOLD`  
**Constant**: `LARGE_PATCH_THRESHOLD = 400` characters

### Problem

Large patch blocks are more likely to fail because:
- Minor whitespace differences across many lines compound
- File modifications between read and edit are more likely to intersect
- Multiple-match ambiguity increases with more context

### Solution

When the patch is large, `checkPatchGranularity()` returns a hint recommending the agent split the edit into smaller, more targeted chunks.

### Example Output

```
Patch block is large (N chars). Consider splitting into smaller, more targeted edits to reduce match failures.
```

Returns an empty string when the patch is within the threshold — no unnecessary noise.

---

## Recovery Escalation Table

| Attempt | Step | Key Action | Marker |
|---------|------|-----------|--------|
| 1 | `REREAD_AND_RETRY` | Re-read file, re-extract, retry | `[EDIT_RECOVERY]` |
| 1 (large patch) | `REREAD_AND_RETRY` + granularity | Same + split-patch hint | `[EDIT_RECOVERY]` |
| 2 | `WRITE_FALLBACK` | Overwrite file entirely | `[EDIT_RECOVERY]` |
| 3+ | `ESCALATE` | Hard stop + MANDATORY change | `[EDIT_RECOVERY]` + `MANDATORY` |

---

## Integration

`buildEditRecoveryGuidance` is called from `loop-detector.ts` inside `detectEditStagnation()`. When stagnation is detected, the failure type and attempt count are fed into the recovery planner, and the resulting guidance is returned as part of the `EditStagnationResult.guidance` string. This is then consumed by `behavior-auditor.ts` and injected into the conversation guidance.

---

## Test Coverage

**File**: `tests/edit-recovery.test.ts` — 36 tests

| Category | Tests |
|---------|-------|
| First failure (REREAD_AND_RETRY) | Re-read mention, max-2 mention, file path in guidance |
| Second failure (WRITE_FALLBACK) | Write mention, prohibits third attempt |
| Third+ failure (ESCALATE) | MANDATORY present, DO NOT retry |
| Large patch (Phase 5) | Granularity hint on attempt 1, threshold boundary |
| `buildWriteFallbackHint` | EDIT_RECOVERY marker, Write, prohibits third |
| `checkPatchGranularity` | Empty below threshold, hint above, char count |

All 36 tests pass.
