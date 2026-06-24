# HYDRATION_FIX_REPORT.md

## Scope

Fixed critical context hydration leakage in the Anthropic-to-Gemini gateway.

No architecture changes. No new runtime surfaces. No filesystem APIs.
Edge-runtime compatible.

---

## Root Cause (detailed)

`deriveSummaryKey` / `deriveConversationId` in `lib/transformers/request.ts`
fallback to hashing `userId | systemText | firstUserMessage` when the client
sends no explicit `conversation_id`.

Claude Code sends an identical system prompt for every session of the same
(or similar) project. The first user message in a new chat is often trivial
(`hi`, `hello`, or a short question). Two completely unrelated sessions therefore
collide on the same Redis key, and the gateway silently injects old compacted
memory into the new session.

---

## Phases Implemented

### Phase 1 — Session isolation

`evaluateHydration` adds a continuity check for single-message sessions
before any Redis context is read. A single trivial message is treated as a
new session; rolling summaries and operational state are not loaded.

### Phase 2 — Workspace boundary enforcement

`extractWorkspaceRootFromSystem` extracts the current workspace from the
system prompt (`<workspacePath>`, `Cwd:` field, etc.).

The stored workspace root is pre-loaded from Redis (via `operationalStateKey`)
and compared. A path mismatch blocks all hydration.

Path normalisation handles Windows/Unix differences (back-slash → forward-slash,
case-insensitive comparison).

### Phase 3 — /clear detection

The last 10 messages are scanned for `/clear`, `/reset`, `clear context`, and
`reset session`. Any match blocks hydration immediately.

### Phase 4 — Semantic continuity check

For sessions with ≤ 3 messages:
- Trivial greetings → blocked
- Continuation signals → approved
- Substantive messages → approved

Sessions with > 3 messages → unconditionally approved (real in-progress work).

### Phase 5 — Compacted block matching

`messagesContainCompactedMarker` detects whether the history already carries
a `<!-- compacted:v2 -->` or `<!-- compacted:v1 -->` sentinel.

If yes → the session is proven; `evaluateHydrationForEstablishedSession` is
used (only workspace and /clear gates apply — continuity is proven by the
marker's presence in client-sent history).

### Phase 6 — Safe fallback

When any gate fails, hydration is silently skipped. The session starts fresh.
No partial or uncertain context is ever injected.

Operational state is always **persisted** even when injection is blocked, so
shell/workspace signals accumulate for future requests.

### Phase 7 — Tests

`tests/context-isolation.test.ts` — 20 test cases covering all gates and
edge cases.

---

## Files Changed

| File | Change |
|------|--------|
| `lib/context/hydration-guard.ts` | **New** — all gate logic, pure functions |
| `lib/transformers/request.ts` | Wired guard before all three hydration points |

---

## Validation

```
npx tsc --noEmit        → 0 errors
npx jest --passWithNoTests → 689 passed, 0 failed (66 suites)
```

New tests: 20/20 passed.

---

## Logged Events

```
HYDRATION_APPROVED
HYDRATION_SKIPPED_WORKSPACE_MISMATCH
HYDRATION_SKIPPED_CLEAR_RESET
HYDRATION_SKIPPED_LOW_CONTINUITY
HYDRATION_SKIPPED_SESSION_MISMATCH
```
