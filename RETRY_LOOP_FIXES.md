# RETRY_LOOP_FIXES.md

## Problem

The user reported a session where Claude Code repeatedly issued the same failing `Bash` tool call (`logs/input.log: No such file or directory`) without changing strategy. The gateway forwarded each turn faithfully but had no mechanism to nudge the model out of the loop.

The gateway cannot prevent the client from sending another request, and it cannot change the model's deterministic output mid-stream. What it **can** do is observe the message history before forwarding it, detect a clear failure pattern, and inject corrective guidance into the system prompt for the next turn.

## Implementation

New module: [lib/transformers/loop-detector.ts](lib/transformers/loop-detector.ts).

### Detection algorithm

1. Walk `anthropicReq.messages` in order.
2. Build `(tool_use, tool_result)` pairs keyed by `tool_use.id`.
3. For each pair compute a stable signature: `${name}|${stableStringify(input)}` — key-sorted JSON so semantically equal inputs collide.
4. Mark a pair `failed` if its `tool_result.is_error === true`, OR its text content matches one of the error patterns:
   - `no such file or directory`, `enoent`
   - `permission denied`
   - `command not found`, `not recognized as ... command`
   - `invalid (input|argument|parameter)`
   - `failed to (read|write|open|execute)`
   - `cannot (find|access|read|write)`
   - lines starting with `error:`
   - `tool execution failed`
5. Walk the pair list **from the tail backwards**, counting consecutive failed pairs sharing the same signature. Stop at the first non-failed pair or signature change.
6. If `runCount >= MIN_REPEATS (=2)`, emit guidance.

### Why "consecutive failures from the tail"
Old, already-resolved errors must NOT trigger the warning. Only an unbroken streak of identical failures touching the latest turn signals a live loop.

### Wiring

[lib/transformers/request.ts](lib/transformers/request.ts) — after `systemText` is computed, before `systemInstruction` is built:

```ts
const loopResult = detectFailureLoop(anthropicReq.messages || []);
if (loopResult.detected) {
  systemText = (systemText ? systemText + '\n' : '') + loopResult.guidance;
  console.warn(`[loop-detector] tool=${...} repeats=${...} input=${...}`);
}
```

The guidance is appended to **systemInstruction**, not to a user turn. This:
- Keeps the user turn untouched (no prompt injection into client-controlled content).
- Gives the guidance authoritative weight (Gemini treats systemInstruction as standing orders).
- Survives across the rest of the conversation if the loop persists.

### Guidance text (verbatim)

```
[GATEWAY LOOP DETECTOR] The previous N attempts to call tool `<name>` with the same arguments all failed with an error. DO NOT repeat the identical call.

Required next step:
1. Read the error message carefully and identify the root cause.
2. Verify your assumptions before retrying — e.g. if a path is missing, list the parent directory first; if a command was not found, check the working directory or use an alternative tool.
3. Change at least one parameter, the tool itself, or the strategy. An identical retry will produce an identical failure.
4. If the error indicates a missing prerequisite (directory, file, dependency), create or locate it first via a different tool call.
5. If you cannot determine a corrective action, stop calling tools and report the blocker in plain text to the user.

Last error observed: <error preview>
```

## Behavior matrix

| Scenario | Detected? |
|---|---|
| First failure of a tool call | No (count=1, threshold=2) |
| Second identical failure with same args | **Yes** |
| Failure → success → same failure again | No (streak broken) |
| Two failures of different tools / different args | No (signatures differ) |
| Old failure followed by successful call followed by new failure | No |
| Many failures, all same | Yes (uses latest streak count) |

## Edge-runtime safety

Pure functions, no Node APIs, no I/O. Safe inside the existing edge route.

## Performance

- O(M) where M = number of messages.
- Does NOT serialize the entire history — `stableStringify` is called only on `tool_use.input` objects, which are small.
- No allocations on the hot path beyond the pair map.

## What it deliberately does NOT do

- It does **not** modify or short-circuit the request to Gemini. Gemini still gets the full history and decides what to do.
- It does **not** lie to the client (no fake `tool_result`, no synthesized `tool_use` rejection).
- It does **not** persist any state across requests. Each request re-detects from the messages it received.

## Tests

See **TEST_PLAN.md** §3 (Loop detector unit tests).

## Tuning knobs (potential follow-ups, not implemented)

- `MIN_REPEATS` could become an env var (`LOOP_DETECTOR_MIN_REPEATS`) if 2 is too aggressive in real traffic.
- The error-pattern list could be moved to a config file for per-deployment customization.
- Could escalate guidance text on higher repeat counts (e.g. at N=4 force `tool_choice: none`). Out of scope for this fix.
