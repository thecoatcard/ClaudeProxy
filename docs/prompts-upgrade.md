# prompts-upgrade.md

## Philosophy

The gateway does not own model prompts — Claude Code sends its own system prompt and the gateway passes it through. The gateway CAN append to `systemInstruction` when it detects specific behavioral problems. All additions in this file are **triggered** (event-driven), not always-on, to minimize token cost and avoid surprising users.

---

## 1. Loop Detection Guidance (ACTIVE — triggered by ≥2 identical failed tool calls)

Source: `lib/transformers/loop-detector.ts` + `lib/agent/retry-strategy.ts`

Appended text pattern:

```
[GATEWAY LOOP DETECTOR] The previous N attempts to call tool `<name>` with the same arguments all failed with an error. DO NOT repeat the identical call.

Required next step:
1. Read the error message carefully and identify the root cause.
2. Verify your assumptions before retrying — e.g. if a path is missing, list the parent directory first.
3. Change at least one parameter, the tool itself, or the strategy.
4. If the error indicates a missing prerequisite, create or locate it first.
5. If you cannot determine a corrective action, stop calling tools and report the blocker.

Last error observed: <error preview>

Root cause: <classified root cause>
Prohibition: Do not call <tool> again with the same arguments.
Required steps:
  1. <alternative step>
  2. <alternative step>
```

**Why triggered, not always-on**: Injecting this every turn adds ~200 tokens for no benefit on healthy sessions. It appears only when blind retries are observed.

---

## 2. Completion Gate Guidance (ACTIVE — triggered when "done" claim + failed tools)

Source: `lib/agent/completion-gate.ts`

Appended text pattern:

```
[GATEWAY COMPLETION GATE] A completion claim was detected in the previous assistant turn, but the tool execution record shows problems:
  • N tool call(s) failed (errors detected in tool_result content).
  • N tool result(s) are ambiguous (could not confirm success).

Completion criterion: do NOT claim the task is done until:
  1. Every required tool call produced a result with no error signals.
  2. If a tool failed, a corrective action was taken and a successful retry is in the record.
  3. You can cite specific tool results as evidence for each claimed outcome.

Detected completion signals: [all tasks complete, ...]
If the task genuinely is complete, provide explicit evidence.
```

**Enforcement rule**: The model must not say "done/complete/finished/all tasks complete" while `tool_result.is_error=true` or error text patterns exist in the history. This is the primary anti-premature-completion control.

---

## 3. Path Guard Guidance (ACTIVE — triggered when path issues detected in recent 20 messages)

Source: `lib/agent/path-guard.ts`

Appended text pattern:

```
[GATEWAY PATH GUARD] N path issue(s) detected in recent tool calls:
  • Path 'path' contains a parent-directory traversal sequence ('..').
  • Path 'file' mixes forward slashes and backslashes.
  • [etc.]

Before every file or directory operation:
  1. Use only forward slashes or only backslashes — never mix them.
  2. Never use "../" sequences to navigate above your working root.
  3. Empty path parameters cause ENOENT — verify the value is set before use.
  4. Shell metacharacters in path values should be moved to argument fields.
```

---

## 4. Spec Validator Guidance (ACTIVE — triggered when system prompt has ≥1 unaddressed numbered requirement)

Source: `lib/agent/spec-validator.ts`

Appended text pattern:

```
[GATEWAY SPEC VALIDATOR] N of M task requirements appear unaddressed:
  1. Write a complex logger
  3. Verify output exists

Do not claim task completion until all listed requirements have a corresponding verified action.
Complete the missing items above before responding with a summary or "done".
```

**Spec fidelity rule**: "complex logger" must not degrade to "simple logger" — the requirement text is preserved verbatim and matched against tool families, not simplified.

---

## 5. Optional: Standing Tool Discipline Note (opt-in via `TOOL_DISCIPLINE_NOTE=1`)

Not currently enabled. When set, this is appended to all requests containing a `tools` array:

```
[Gateway tool-use discipline]
- Before invoking a tool, briefly state the goal and the assumption you are testing.
- Never repeat an identical failed tool invocation.
- Verify prerequisites before path-dependent calls.
- When a tool returns an error, classify it and act on the classification.
- After a tool result, summarize what changed before the next call.
```

---

## 6. Optional: Force-text on persistent loop (opt-in via `LOOP_FORCE_TEXT=1`)

When the same loop persists ≥4 times AND `LOOP_FORCE_TEXT=1`, the gateway sets `toolConfig.functionCallingConfig.mode = 'NONE'` for that request, forcing a text-only response. This hard-breaks the loop at the cost of surprising the client. Disabled by default.

---

## Before / After Comparison

| Behavior | Before | After |
|---|---|---|
| Blind retry of identical failed tool | Model retries without guidance | Loop detector fires at repeat #2, injects root cause + alternative strategy |
| "All done" with failed tools in history | No intervention | Completion gate fires, blocks with evidence requirement |
| Path traversal in tool input | No intervention | Path guard fires, injects path discipline note |
| Numbered task list partially done | No intervention | Spec validator fires, lists unaddressed items |
| All tools succeed, no loops | No extra tokens | No guidance injected — zero overhead |
