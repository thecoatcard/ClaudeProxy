# PROMPT_UPGRADES.md

The gateway should remain prompt-passthrough by default — silently mutating user prompts breaks user trust and complicates debugging. The only system-prompt augmentation in this audit is the **loop-detector guidance** ([RETRY_LOOP_FIXES.md](RETRY_LOOP_FIXES.md)), which fires only when a clear failure pattern is observed.

This file lists optional, low-risk additions you can opt into via env vars.

## A. Standing tool-use discipline note (opt-in)

When `TOOL_DISCIPLINE_NOTE=1`, append the following to `systemInstruction` for any request that includes a `tools` array. This is generic, model-agnostic, and aligned with what well-behaved Claude Code sessions already do. Recommended only for users running custom clients.

```text
[Gateway tool-use discipline]
- Before invoking a tool, briefly state the goal and the assumption you are testing.
- Never repeat an identical failed tool invocation. If a call fails, change at least one parameter, the tool, or the strategy.
- Verify prerequisites before destructive or path-dependent calls (e.g. confirm a directory exists before writing into it).
- When a tool returns an error, read the error message, classify it (missing prerequisite, wrong arguments, transient failure), and act on the classification.
- Prefer narrow, verifiable actions over broad "do everything" commands.
- After a tool result, summarize what changed in one sentence before the next tool call.
```

This is **not enabled by default**. Enable per-deployment.

## B. Loop-detector guidance (always-on, already implemented)

Emitted only when `detectFailureLoop()` finds ≥2 consecutive identical failed tool calls.

```text
[GATEWAY LOOP DETECTOR] The previous N attempts to call tool `<name>` with the same arguments all failed with an error. DO NOT repeat the identical call.

Required next step:
1. Read the error message carefully and identify the root cause.
2. Verify your assumptions before retrying — e.g. if a path is missing, list the parent directory first; if a command was not found, check the working directory or use an alternative tool.
3. Change at least one parameter, the tool itself, or the strategy. An identical retry will produce an identical failure.
4. If the error indicates a missing prerequisite (directory, file, dependency), create or locate it first via a different tool call.
5. If you cannot determine a corrective action, stop calling tools and report the blocker in plain text to the user.

Last error observed: <error preview>
```

## C. Optional escalation when loop persists (NOT implemented — proposal)

If the same loop persists past `MIN_REPEATS + 2` (i.e. 4 identical failures), the gateway could transparently set `tool_choice: { type: 'none' }` for the next request. This forces the model to produce text instead of yet another tool call, breaking the loop hard.

Trade-off: surprising behavior for clients that build their own tool-routing on top of `tool_choice`. Defer to per-user opt-in:

```ts
if (loopResult.detected && loopResult.diagnostics?.repeats >= 4 && process.env.LOOP_FORCE_TEXT === '1') {
  geminiReq.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
}
```

## D. What we deliberately do NOT add

- **No `<system>` injection into user content.** All gateway notes go to `systemInstruction`.
- **No fake assistant turns.** The gateway never fabricates `assistant` messages — these would corrupt the client-visible history.
- **No per-tool prompt rewriting.** Schema-based hints belong in the tool's own `description`.
- **No "agent persona" prompts.** This gateway translates protocols; it is not a meta-agent. If you want planner/executor/verifier sub-agents, build them in the *client*, not in the translator.

## E. Env-var summary (current + proposed)

| Var | Current | Behavior |
|---|---|---|
| `MAX_RETRIES` | implemented | Gemini retry attempts per request. |
| `KEY_COOLDOWN_429` / `KEY_COOLDOWN_503` | implemented | Per-error-class key cooldowns. |
| `CONTEXT_COMPACTION_TARGET_TOKENS` | implemented | Compaction target. |
| `CONTEXT_COMPACTION_TARGET_TOKENS_LITE` | implemented | Compaction target for `lite` models. |
| `CONTEXT_COMPACTION_MAX_MESSAGES` / `KEEP_FIRST` / `KEEP_LAST` | implemented | Compaction shape. |
| `CONTEXT_SUMMARY_TTL` | implemented | Rolling summary TTL. |
| `TOOL_RESULT_MAX_CHARS` / `TOOL_RESULT_TAIL_CHARS` | implemented | Tool-result truncation cap. |
| `TOOL_DISCIPLINE_NOTE` | proposed | Section A above. |
| `LOOP_FORCE_TEXT` | proposed | Section C above. |
| `LOOP_DETECTOR_MIN_REPEATS` | proposed | Override default `2`. |
