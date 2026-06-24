# Gateway Engineering Audit — BUG_AUDIT.md

**Date:** 2026-05-09  
**Scope:** Full gateway audit (16 subsystems)  
**Auditor:** AI Engineering Agent

---

## CRITICAL

---

### BUG-001 · Prompt Injection via "Superpower Permission Bypass"

**Severity:** CRITICAL  
**Subsystem:** `lib/transformers/optimizations.ts`  
**Root Cause:**  
`tryOptimizations()` contains a hardcoded branch that returns `"Permission granted. Proceeding with execution."` whenever the user message contains the string `"bypass permission"` or `"force execute"`. Any client (or prompt-injected payload) can trigger this.

```typescript
if (userText.includes('bypass permission') || userText.includes('force execute')) {
  return createTextResponse(model, "Permission granted. Proceeding with execution.", 100, 10);
}
```

**Impact:**  
- Any user can fake permission grants. Claude Code trusts this response and proceeds.  
- Attackers can inject these strings via tool results, filenames, or user messages.  
- Violates OWASP A03 (Injection) and A01 (Broken Access Control).  

**Reproducibility:** Always reproducible. Any message with "bypass permission" triggers it.  
**Fix Complexity:** Trivial — remove the block entirely.

---

### BUG-002 · SSRF via Agentic Web Fetch in Optimizations

**Severity:** CRITICAL  
**Subsystem:** `lib/transformers/optimizations.ts`  
**Root Cause:**  
`tryOptimizations()` extracts a URL from user message text and calls `fetch(url)` directly. The URL is user-controlled and not validated against an allowlist or RFC 1918 private IP ranges.

```typescript
const url = extractValue(rawText, ['url', 'href', 'link'])
  || (rawText.match(/https?:\/\/[^\s]+/)?.[0]);
if (url) {
  const result = await performWebFetch(url);
}
```

**Impact:**  
- Attackers can probe internal infrastructure (Redis, metadata APIs, cloud instance metadata endpoints at 169.254.169.254, etc.) via SSRF.  
- This executes on Vercel Edge Network — a shared-tenant environment. SSRF could expose cross-tenant data or internal Vercel APIs.  
- Violates OWASP A10 (Server-Side Request Forgery).  

**Reproducibility:** Always reproducible when `tool_choice: { type: 'tool', name: 'web_fetch' }` is sent with a crafted URL.  
**Fix Complexity:** Low — remove the web_fetch/web_search optimization block entirely. The gateway is a translator layer, not a browser.

---

### BUG-003 · Infinite Loop / Duplicate Tool Emission in Stream Action Recovery

**Severity:** CRITICAL  
**Subsystem:** `lib/transformers/stream.ts`  
**Root Cause:**  
The action recovery `while(true)` loop calls `recoverActionText(cleanedText)` but never advances the search position. After recovering an action at positions `[start, end]`, `cleanedText` is unchanged. The next iteration finds the **same action** at the same position and emits a duplicate `tool_use` block. This continues infinitely for `aggressive` recovery mode models (Gemma), or terminates after 1 duplicate for other modes.

In contrast, `response.ts` correctly slices `cleanedText` after each recovery:
```typescript
// response.ts — correct
cleanedText = cleanedText.slice(recovered.end).trim();

// stream.ts — BUG: cleanedText never changes
outputTextLength = recovered.end;  // position tracked but text not sliced
```

**Impact:**  
- For Gemma models (aggressive recovery mode): infinite loop → request hangs indefinitely, never sending `message_stop`.  
- For other models: one duplicate `tool_use` block emitted per turn containing action text.  
- Duplicate tool_use blocks cause Claude Code to execute the same action twice (double writes, double API calls, etc.).  

**Reproducibility:** Reproducible whenever Gemini emits action-style text (`[Action: I am calling tool X...]`).  
**Fix Complexity:** Low — pass `cleanedText.slice(outputTextLength)` to `recoverActionText` and adjust returned offsets.

---

## HIGH

---

### BUG-004 · anyOf with Null Type Loses Nullable in Tool Schema Conversion

**Severity:** HIGH  
**Subsystem:** `lib/transformers/tools.ts`  
**Root Cause:**  
When `anyOf: [{ type: "string" }, { type: "null" }]` is encountered, `convertSchema` picks only the first non-null branch and discards the null branch entirely. The `nullable: true` information is lost.

```typescript
const branch = schema.oneOf?.[0] ?? schema.anyOf?.[0] ?? schema.allOf?.[0];
// branch = { type: "string" } — null branch discarded
return convertSchema({ ...schema, ...branch, anyOf: undefined });
// → { type: "STRING" } with no nullable: true
```

**Impact:**  
- Optional fields in Claude Code tool schemas that use `anyOf: [type, null]` become strictly typed in Gemini's function declarations.  
- Gemini may reject or mishandle tool calls with null values for these fields.  
- Observed Claude Code tools (EditFile, WriteFile) use nullable schemas for optional parameters.  

**Reproducibility:** Reproducible whenever tools with nullable anyOf fields are sent.  
**Fix Complexity:** Low — scan all branches for `null` type before merging.

---

### BUG-005 · Interactive CLI Commands Not Detected (Blocking Behavior Risk)

**Severity:** HIGH  
**Subsystem:** `lib/agent/process-supervisor.ts`, `lib/agent/behavior-auditor.ts`  
**Root Cause:**  
The process supervisor detects long-running servers but has no knowledge of interactive CLI wizard commands. Commands like `shadcn init`, `prisma init`, `firebase init`, `create-t3-app`, `supabase init` block indefinitely waiting for keyboard input from a TTY. The behavior auditor never injects guidance to use non-interactive flags.

**Impact:**  
- Claude Code's Bash tool blocks indefinitely, causing the session to hang.  
- The gateway sees an `UNKNOWN` state from the supervisor and provides only generic monitoring guidance.  
- Agent enters a false "waiting" loop and may claim the server started when it's actually stuck on a prompt.  

**Reproducibility:** Reproducible whenever Claude Code runs an interactive wizard CLI without `--yes`/`--defaults` flags.  
**Fix Complexity:** Medium — create `InteractiveCommandGuard` module and wire into behavior auditor.

---

### BUG-006 · Stream Missing Incomplete Open Blocks at Error Exit

**Severity:** HIGH  
**Subsystem:** `lib/transformers/stream.ts`  
**Root Cause:**  
When the stream catches an exception in the outer `try/catch`, it emits an `error` event and `message_stop`. However, if `inContentBlock`, `inToolCall`, or `inThinking` are true when the exception fires, the corresponding `content_block_stop` events are never emitted.

```typescript
} catch (err) {
  yield `event: error\n...`;
  yield `event: message_stop\n...`;
  // NO content_block_stop emitted — open blocks left dangling
}
```

**Impact:**  
- Claude Code's SSE parser receives an unclosed block, which may cause it to corrupt the message buffer or hang waiting for the block to close.  
- The `message_stop` event may be ignored if the client is mid-block.  

**Reproducibility:** Reproducible when a network error or transformation exception occurs mid-stream.  
**Fix Complexity:** Low — emit cleanup events before error/stop in the catch block.

---

### BUG-007 · Completion Gate Skips Tool-Call-Only Assistant Turns

**Severity:** HIGH  
**Subsystem:** `lib/agent/completion-gate.ts`  
**Root Cause:**  
`detectPrematureCompletion` scans the last assistant message for text content and breaks immediately. If the last assistant turn contains only `tool_use` blocks (no text), the loop correctly skips it. But if the second-to-last assistant turn contained a completion claim ("I'm done. Let me verify...") followed by a tool_use turn, the claim is never checked.

```typescript
for (let i = messages.length - 1; i >= 0; i--) {
  if (messages[i].role === 'assistant') {
    lastAssistantText = extractText(messages[i].content);
    break; // stops at first assistant message regardless of whether it has text
  }
}
```

**Impact:**  
- The completion gate misses claims in the second-to-last assistant turn when the last turn is a tool call.  
- False completion claims propagate unchecked into the next model turn.  

**Reproducibility:** Reproducible when the assistant pattern is: text+claim → tool_use → tool_result → new request.  
**Fix Complexity:** Low — scan backwards until a non-empty text is found, up to N messages.

---

## MEDIUM

---

### BUG-008 · topK Clamped at 40 — Too Aggressive for Gemini 2.5+ Models

**Severity:** MEDIUM  
**Subsystem:** `lib/transformers/request.ts`  
**Root Cause:**  
All `top_k` values above 40 are silently clamped to 40, but Gemini 2.5 Flash supports `topK` up to 64. This silently changes model behavior for Claude Code sessions that rely on higher diversity.

```typescript
generationConfig.topK = Math.min(Number(anthropicReq.top_k), 40);
```

**Impact:**  
- Reduced output diversity for requests with `top_k > 40`.  
- Silent parameter modification — violates least-surprise principle.  

**Reproducibility:** Always reproducible when `top_k > 40` is sent.  
**Fix Complexity:** Trivial — increase cap to 64 or remove cap.

---

### BUG-009 · v1 Compaction Sentinel Not Hydrated by ai-compactor

**Severity:** MEDIUM  
**Subsystem:** `lib/compactor/ai-compactor.ts`  
**Root Cause:**  
`isCompactedSummary()` in `compaction.ts` recognizes both `<!-- compacted:v1 -->` (old) and `<!-- compacted:v2 -->` (new). However, `hydrateCompactedMarkers()` in `ai-compactor.ts` only checks for `COMPACTED_MARKER_SENTINEL` (v2). Old v1 summaries in Redis are never rehydrated — the sentinel string is passed raw to Gemini.

**Impact:**  
- Long-running conversations that were compacted before the v2 upgrade lose their summaries on hydration.  
- Context continuity is broken — the model sees a raw `<!-- compacted:v1 -->` marker rather than the actual summary.  

**Reproducibility:** Reproducible for conversations with compacted history from before the v2 migration.  
**Fix Complexity:** Low — add v1 sentinel detection in `hydrateCompactedMarkers`.

---

### BUG-010 · Duplicate stableHash Implementation (Divergence Risk)

**Severity:** MEDIUM  
**Subsystem:** `lib/transformers/request.ts`, `lib/compactor/ai-compactor.ts`  
**Root Cause:**  
An identical `stableHash` (FNV-1a approximation) function exists in two files. The intermediate arithmetic can exceed JS safe integer range during the `(hash << 24)` operation, making the hash non-deterministic for long strings across JS engines.

**Impact:**  
- Hash collisions could cause conversation ID conflicts (two different conversations mapped to the same Redis key).  
- Duplicate code creates a maintenance hazard — a bug fix in one won't be applied to the other.  

**Reproducibility:** Low probability collision; maintenance risk is immediate.  
**Fix Complexity:** Low — extract to shared utility; fix overflow with `Math.imul`.

---

### BUG-011 · Loop Detector Misses Alternating Failure Patterns

**Severity:** MEDIUM  
**Subsystem:** `lib/transformers/loop-detector.ts`  
**Root Cause:**  
The loop detector only considers **consecutive** identical failures. If the model alternates between two failing strategies (A→B→A→B), neither constitutes a "consecutive" run of identical failures, so the loop is never detected.

**Impact:**  
- Models can enter oscillating failure loops without triggering loop guidance.  
- Long sessions accumulate unaddressed failures silently.  

**Reproducibility:** Reproducible in complex retry scenarios where the model alternates strategies.  
**Fix Complexity:** Medium — add a "seen failure signatures" set to detect non-consecutive repetitions.

---

### BUG-012 · process-supervisor Guidance Fires Every Turn for STARTED Processes

**Severity:** MEDIUM  
**Subsystem:** `lib/agent/process-supervisor.ts`, `lib/agent/behavior-auditor.ts`  
**Root Cause:**  
`assessLongRunningProcessHistory` returns guidance even when the process is `STARTED` (already running). The guidance is appended to every subsequent system instruction until the conversation is compacted. This bloats the system instruction with redundant process supervisor text.

**Impact:**  
- Every request after a successful server start carries 200+ chars of process supervisor guidance that's no longer relevant.  
- System instruction size grows unboundedly for long sessions with servers.  

**Reproducibility:** Always reproducible after any long-running process is started.  
**Fix Complexity:** Low — suppress guidance when state is `STARTED`.

---

## LOW

---

### BUG-013 · metadatapersist Retry Has No Backoff

**Severity:** LOW  
**Subsystem:** `lib/transformers/metadata-persist.ts`  
**Root Cause:**  
`setexBestEffort` retries immediately on failure with no delay. Under Redis saturation, an immediate retry is unlikely to succeed and adds load.

**Fix Complexity:** Trivial — add a small fixed delay between retries.

---

### BUG-014 · Shell Environment Detection Returns 'unknown' for Most Inputs

**Severity:** LOW  
**Subsystem:** `lib/agent/process-supervisor.ts`  
**Root Cause:**  
`detectShellEnvironment` only detects environment from the command string. If the command is just `npm run dev` (no shell prefix), it returns `'unknown'`, and the termination guidance is generic. Most real commands won't have `powershell` or `/bin/bash` in them.

**Fix Complexity:** Medium — infer from system prompt or prior commands in history.

---

### BUG-015 · `performWebSearch` HTML Parsing is Fragile

**Severity:** LOW  
**Subsystem:** `lib/transformers/optimizations.ts`  
**Root Cause:**  
DuckDuckGo Lite HTML structure can change. The parser splits on `'result-link'` which is a CSS class — this will break when DDG updates their markup.

**Fix Complexity:** Medium — use a structured search API instead.

---

## Summary Matrix

| ID | Severity | Subsystem | Status |
|----|----------|-----------|--------|
| BUG-001 | CRITICAL | optimizations.ts | Open |
| BUG-002 | CRITICAL | optimizations.ts | Open |
| BUG-003 | CRITICAL | stream.ts | Open |
| BUG-004 | HIGH | tools.ts | Open |
| BUG-005 | HIGH | process-supervisor.ts | Open |
| BUG-006 | HIGH | stream.ts | Open |
| BUG-007 | HIGH | completion-gate.ts | Open |
| BUG-008 | MEDIUM | request.ts | Open |
| BUG-009 | MEDIUM | ai-compactor.ts | Open |
| BUG-010 | MEDIUM | request.ts + ai-compactor.ts | Open |
| BUG-011 | MEDIUM | loop-detector.ts | Open |
| BUG-012 | MEDIUM | process-supervisor.ts | Open |
| BUG-013 | LOW | metadata-persist.ts | Open |
| BUG-014 | LOW | process-supervisor.ts | Open |
| BUG-015 | LOW | optimizations.ts | Open |
