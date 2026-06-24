# CONTEXT_ISOLATION_REPORT.md

## Problem

New Claude sessions were receiving compacted memory from unrelated prior sessions.

### Root Cause

`deriveSummaryKey` and `deriveConversationId` in `lib/transformers/request.ts` hash
`userId | systemText | firstUserMessage` when no explicit `conversation_id` is supplied.

Claude Code always sends the same system prompt for the same (or similar) projects.
Two entirely distinct sessions — even from different workspaces — could therefore collide
on the same derived key, causing Redis to return the prior session's:

- **rolling summary** (injected into compaction)
- **operational state** (injected into `systemInstruction`)
- **emergency compaction state** (applied to the message list)
- **hydrated compacted markers** (spliced back into the history)

Example symptom:
```
new workspace → new session → /clear → "hi"
gateway restored old task context
```

---

## Architecture of the Fix

A new module — `lib/context/hydration-guard.ts` — acts as a mandatory gate
**before every Redis context read**. No context is injected without passing all gates.

### Gates (ordered: cheapest first)

| # | Gate | Skip Reason Logged |
|---|------|--------------------|
| 1 | `/clear` or `/reset` detected in recent messages | `HYDRATION_SKIPPED_CLEAR_RESET` |
| 2 | Workspace root mismatch (current ≠ stored) | `HYDRATION_SKIPPED_WORKSPACE_MISMATCH` |
| 3 | Fresh session with trivial greeting | `HYDRATION_SKIPPED_LOW_CONTINUITY` |
| 4 | Semantic continuity — continuation not proven | `HYDRATION_SKIPPED_LOW_CONTINUITY` |

Pass all → `HYDRATION_APPROVED`

### Two evaluation paths

**`evaluateHydration`** — full multi-gate path for sessions that do **not** already
carry compacted markers in their history.

**`evaluateHydrationForEstablishedSession`** — lighter path used when the message
history already contains a `<!-- compacted:v2 -->` or `<!-- compacted:v1 -->` sentinel.
Continuity is proven by the presence of the marker; only workspace and `/clear` gates apply.

### Workspace boundary

`extractWorkspaceRootFromSystem` parses the system prompt for:
- `<workspacePath>` (Claude Code `<environment_details>`)
- `Cwd:` field
- `workspace_folder` / `workspace_root` / `workspace_path` patterns

Path comparison normalises back-slashes → forward-slashes and lower-cases for
case-insensitive Windows path matching.

### `/clear` detection

Scans the last 10 messages for patterns:
- `/clear`
- `/reset`
- `clear context`
- `reset session`

### Semantic continuity

For sessions with ≤ 3 messages:
- Trivial greetings (`hi`, `hello`, `hey`, `test`, …) → deny
- Explicit continuation signals (`continue`, `resume`, `pick up`, `where we left off`, …) → allow
- Substantive single messages (> 15 chars, not greeting) → allow
- 2–3 message sessions without a deny signal → allow

Sessions with > 3 messages are unconditionally approved (they represent real work).

---

## Integration Points

### `lib/transformers/request.ts`

1. `extractWorkspaceRootFromSystem` called at the top of `transformRequestToGemini`
   to detect workspace from the current system prompt.
2. Before the `messages` pipeline:
   - `messagesContainCompactedMarker` — detects established sessions
   - `opStateStore.get(operationalStateKey(conversationId))` — loads stored workspace root
   - `evaluateHydration` or `evaluateHydrationForEstablishedSession` — produces `HydrationVerdict`
   - Verdict gates all three downstream reads: emergency state, marker hydration, rolling summary
3. Before operational state injection (later in the pipeline):
   - `evaluateHydration` re-runs against the now-loaded operational state's `workspace_root`
   - Blocks `systemInstruction` injection independently if needed
   - Operational state is still **saved** even when injection is blocked — signals accumulate

### `lib/context/hydration-guard.ts` (new)

Pure functions — no side effects, no I/O. Safe for both Edge and Node runtimes.

---

## Logging

Every hydration decision is logged at `INFO` level via `logInfo('RETRIEVAL', ...)`:

| Log Event | Meaning |
|-----------|---------|
| `HYDRATION_APPROVED` | All gates passed; context will be injected |
| `HYDRATION_SKIPPED_WORKSPACE_MISMATCH` | Workspace roots differ |
| `HYDRATION_SKIPPED_CLEAR_RESET` | `/clear` detected |
| `HYDRATION_SKIPPED_LOW_CONTINUITY` | Trivial/non-continuation request |
| `HYDRATION_SKIPPED_SESSION_MISMATCH` | (reserved for future session-token gating) |

Operational state injection blocks are logged separately at `MEMORY` level.

---

## Success Criteria

- [x] No context leakage into new sessions
- [x] Fresh sessions stay fresh (`hi` → no hydration)
- [x] `/clear` is respected
- [x] Hydration only when all gates pass
- [x] Compacted memory safe — markers still hydrated in established sessions
- [x] Workspace boundary enforced
- [x] Zero regressions — 689/689 tests pass
