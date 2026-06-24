# Tool Loop Fix Report

## Overview

This report documents Phases 1 and 7 of the tool behavior hardening initiative: detection of edit stagnation loops and enforcement of mandatory strategy changes when loops are detected.

---

## Phase 1 — Edit Stagnation Detection

**File**: `lib/transformers/loop-detector.ts`  
**Export**: `detectEditStagnation(messages: ConversationMessage[]): EditStagnationResult`

### Return Type

```typescript
interface EditStagnationResult {
  detected: boolean;
  stagnationType: 'READ_EDIT_LOOP' | 'REPEATED_EDIT_FAIL' | null;
  guidance: string;
  diagnostics: {
    toolName: string;
    filePath: string;
    failureCount: number;
    lastFailureType: string;
    lastError: string;
  } | null;
}
```

### Pattern 1: READ_EDIT_LOOP

**Trigger**: Any file that has been read and then failed to edit at least twice.

**Detection Logic**:
1. Walk all messages in order
2. Track each file that appears in a successful read tool call
3. Track each file that appears in a failed edit tool call
4. If a file has been read AND has ≥ 2 edit failures → `READ_EDIT_LOOP` detected

This pattern catches the classic anti-pattern:
```
→ read_file(/src/foo.ts)       ✓
→ edit_file(/src/foo.ts)       ✗ EXACT_MATCH_FAILURE
→ read_file(/src/foo.ts)       ✓
→ edit_file(/src/foo.ts)       ✗ WHITESPACE_MISMATCH
  ↑ DETECTED: READ_EDIT_LOOP
```

### Pattern 2: REPEATED_EDIT_FAIL

**Trigger**: Two or more consecutive edit failures on the same file from the tail of the conversation.

**Detection Logic**:
1. Start from the most recent messages and walk backward
2. Build a consecutive sequence of edit failures on the same file
3. If sequence length ≥ 2 → `REPEATED_EDIT_FAIL` detected

This catches rapid retry loops where the agent does not re-read between attempts:
```
→ edit_file(/src/bar.ts)       ✗ NO_MATCH_FOUND
→ edit_file(/src/bar.ts)       ✗ NO_MATCH_FOUND
  ↑ DETECTED: REPEATED_EDIT_FAIL
```

### Guidance Marker

All stagnation guidance includes `[TOOL_LOOP_STAGNATION]` for filtering and observability.

---

## Phase 7 — Loop Breaker

**File**: `lib/agent/behavior-auditor.ts`  
**Threshold**: `failureCount >= 3`

### Mechanism

When `detectEditStagnation` returns `detected: true` with `diagnostics.failureCount >= 3`, the behavior auditor injects an additional hard-stop block on top of the recovery guidance:

```
[LOOP_BREAKER] MANDATORY: Change strategy now. DO NOT make another identical edit attempt. 
Switch to Write, Insert, or ask for user guidance.
```

This complements the `ESCALATE` step from `buildEditRecoveryGuidance`, which already emits `MANDATORY` language at attempt 3+. The dual enforcement (from both the loop detector and the recovery planner) ensures the constraint cannot be missed.

### Auditor Integration

```typescript
// Phase 0 in behavior-auditor.ts — runs before all other checks
const stagnationResult = detectEditStagnation(messages);
if (stagnationResult.detected && stagnationResult.diagnostics) {
  guidanceParts.push(stagnationResult.guidance);
  if (stagnationResult.diagnostics.failureCount >= 3) {
    guidanceParts.push('[LOOP_BREAKER] MANDATORY: Change strategy now...');
  }
}
```

New fields added to `BehaviorAuditResult.diagnostics`:
- `editStagnationDetected: boolean`
- `editStagnationType: 'READ_EDIT_LOOP' | 'REPEATED_EDIT_FAIL' | null`
- `editStagnationFailures: number`

---

## Detection Boundaries

| Scenario | Detected? | Type |
|---------|-----------|------|
| 1 edit failure after read | No | — |
| 2 edit failures after read | Yes | READ_EDIT_LOOP |
| 2 consecutive failures, same file | Yes | REPEATED_EDIT_FAIL |
| 2 consecutive failures, different files | No | — |
| 3+ failures | Yes + MANDATORY | READ_EDIT_LOOP or REPEATED_EDIT_FAIL |

---

## Phase 8 — Windows Path Normalization

Both loop patterns use `normalizePath()` from `edit-failure-classifier.ts` when comparing file paths:

- Backslash → forward slash
- Lowercase
- Trim trailing slash

This means `C:\src\Foo.ts` and `c:/src/foo.ts` are treated as the same file, preventing false negatives on Windows.

CRLF-terminated error messages are normalized via `normalizeLineEndings()` before classification, ensuring Windows tool outputs are classified correctly.

---

## Test Coverage

**File**: `tests/tool-loop-detector.test.ts` — 22 tests

| Category | Tests |
|---------|-------|
| READ_EDIT_LOOP detection | 1 failure=no detect, 2 failures=detect, stagnationType, guidance markers |
| Different files not cross-detected | Correct isolation |
| Windows path normalization (Phase 8) | `C:\src\file.ts` = `c:/src/file.ts` |
| REPEATED_EDIT_FAIL detection | 2 consecutive=detect, 1=not detect, different files=not detect |
| Phase 7 (3+ failures) | MANDATORY in guidance |
| Phase 8 CRLF | CRLF in error text classifies correctly |
| Generic `detectFailureLoop` regression | Existing tests continue to pass |

All 22 tests pass.
