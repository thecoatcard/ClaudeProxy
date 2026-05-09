# BEHAVIOR_FIX_REPORT.md

## Summary

This report documents the four behavioral defects identified in the Anthropic→Gemini gateway and the corrective systems built to address each one.

---

## Defect 1 — Blind retry loops (no termination)

**Problem:** When a tool call fails (e.g. ENOENT, permission denied, bad arguments), the model receives no structural signal beyond the raw error text in `tool_result`. With no explicit prohibition, models frequently re-invoke the identical call with identical arguments, looping until the token budget is exhausted.

**Evidence pattern:**
```
assistant: tool_use  name=write_file  input={ path: '/tmp/out.txt' }
user:      tool_result  is_error=true  "ENOENT: /tmp/out.txt"
assistant: tool_use  name=write_file  input={ path: '/tmp/out.txt' }   ← identical
user:      tool_result  is_error=true  "ENOENT: /tmp/out.txt"           ← identical
```

**Fix:** `lib/transformers/loop-detector.ts` + `lib/agent/retry-strategy.ts`

- Walks the message history to build `(tool_use, tool_result)` pairs keyed by tool-use ID.
- Computes a stable signature `${name}|${stableStringify(input)}` for each pair.
- Walks backwards counting consecutive failed pairs with the same signature.
- At `MIN_REPEATS=2`, fires and injects guidance into `systemInstruction`.
- `retry-strategy.ts` classifies the error (`missing_parent_dir`, `permission_denied`, `command_not_found`, etc.) and generates concrete alternative steps.
- The injected guidance names the tool, the repeat count, the error, the root cause, and the prohibition.

---

## Defect 2 — Premature completion claims

**Problem:** Models frequently output "All tasks complete" or "Done." when the tool-result record contains failures or ambiguous results. This causes the client (Claude Code) to stop, leaving the task incomplete.

**Evidence pattern:**
```
assistant: tool_use  name=write_file  ...
user:      tool_result  is_error=true  "Permission denied"
assistant: "I've completed all the required tasks. All files have been written."  ← claim with failure in record
```

**Fix:** `lib/agent/completion-gate.ts`

- Scans the last assistant message for completion signal phrases: "all tasks complete", "all done", "task done", "implementation complete", "i have completed all", "setup complete", standalone "done/complete/finished", etc.
- When found, calls `verifyAllToolResults` on the full message history.
- If any tool result has `verdict === 'failure'`, injects blocking guidance listing the failed calls and requiring evidence before the claim is accepted.
- Does NOT block when all verifiable results are `success` or `uncertain`.

---

## Defect 3 — Path structural errors undetected

**Problem:** Models occasionally pass structurally malformed paths: `../../../etc/passwd`, `C:\foo/bar` (mixed), empty string, null byte injection, shell metacharacters like `$(cmd)`. These cause errors that the model then retries blindly (Defect 1).

**Fix:** `lib/agent/path-guard.ts`

- Extracts all string values from `tool_use.input` in the last 20 messages.
- Tests each value for: traversal sequences (`../`), mixed separators, empty string, null byte (`\x00`), shell metacharacters (`$`, `` ` ``, `|`, `;`, `&`, `>`).
- Builds a per-issue guidance note injected into `systemInstruction`.
- Runs as a lower-priority check (after loop and completion gate) so high-severity issues take precedence.

---

## Defect 4 — Task spec drift / silent requirement omission

**Problem:** When a system prompt contains a numbered task list, models may complete only a subset and then claim completion (Defect 2), or silently simplify a requirement (e.g. "implement complex logger" → write a `console.log` call).

**Fix:** `lib/agent/spec-validator.ts`

- Extracts numbered (`1.`, `2.`) and bulleted (`-`, `*`, `•`) requirements from the system prompt text.
- For each requirement, identifies the expected tool family using `TOOL_HINT_MAP` (write, read, bash, delete, move, search).
- Tracks which requirements have a corresponding successful tool call of the matching family in the message history.
- When unaddressed requirements exist, lists them verbatim and injects a pre-completion requirement into `systemInstruction`.
- Requirement text is preserved verbatim — no simplification or inference.

**Key design choices:**
- Hint matching uses verb-only patterns on the requirement text, not on tool output (prevents failure from being counted as success).
- The `TOOL_HINT_MAP` write pattern: `/\b(write|create|save|generate|output|produce|implement|build|add)\b/i` — broad enough to catch "Write app.ts", "Create a module", "Implement the logger".
- `successfulFamilies` only contains tool families whose `verifyToolResult` verdict is `success` — failed calls do not count.

---

## Integration Point

All four checks are orchestrated by `lib/agent/behavior-auditor.ts`, called from `lib/transformers/request.ts`:

```typescript
const auditResult = await runBehaviorAudit(anthropicReq.messages || [], systemText);
if (auditResult.hasGuidance) {
  systemText = (systemText ? systemText + '\n' : '') + auditResult.guidance;
}
```

Priority order (highest → lowest): loop detection → completion gate → path guard → spec validator.

Multiple checks can fire per request. Guidance is concatenated with newline separators. Each block is prefixed with a `[GATEWAY ...]` tag so the model can distinguish gateway-injected notes from user system prompt content.

---

## Token Overhead

| Check | When it fires | Approximate tokens added |
|---|---|---|
| Loop detector | ≥2 identical failed calls | ~120–200 |
| Completion gate | "done" claim + failed tools | ~80–150 |
| Path guard | Path issues in last 20 messages | ~60–120 |
| Spec validator | Unaddressed requirements exist | ~40–80 per unaddressed item |
| None | Clean session | 0 |

Checks are event-driven, not always-on. A healthy session with no loops, no premature claims, no path errors, and a complete task record incurs **zero added tokens**.
