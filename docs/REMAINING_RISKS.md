# REMAINING_RISKS.md

## 1. Content-based verification is heuristic, not ground truth

`lib/agent/verification-engine.ts` classifies tool results by pattern-matching the `tool_result` text. There is no filesystem call, no state read, no external check. This means:

- A tool that returns "File created successfully." but actually failed silently will be misclassified as `success`.
- A tool that returns an empty string on success (e.g. a shell command with no stdout) will be classified `uncertain`.
- Custom MCP tools with non-standard error formats may be classified `uncertain` or even `success` when they failed.

**Mitigation:** The `is_error: true` flag is checked first and always overrides text matching. Any model/MCP tool that sets `is_error=true` on failure will be classified correctly.

**Residual risk:** MCP tools that return errors in the text body without setting `is_error=true`. Nothing in the gateway can fix this — it requires the tool author to set the flag correctly.

---

## 2. Spec validator does not understand semantic equivalence

`lib/agent/spec-validator.ts` matches requirement verbs (write, create, read, bash, etc.) against tool families. It does not understand that:

- "Write a configuration file" could be satisfied by `bash: echo '...' > config.json`.
- "Run the tests" could be satisfied by `bash: pytest` or `bash: npm test` (all correctly mapped to `bash` family, this works).
- "Deploy the service" has no explicit tool-family mapping and would fall through to keyword matching.

Requirements with no recognized verb and no keyword overlap in assistant text will be permanently unaddressed even if the model completes them via unconventional tool names.

**Mitigation:** The check only fires when `systemText.length > 100` (short prompts are not task lists). Requirements left as `unaddressed` still allow the request to proceed — guidance is injected but not blocking.

---

## 3. Loop detector fires on `MIN_REPEATS=2` which may be too eager

The current threshold means a single retry is always allowed, and the second identical failed call fires the detector. This is correct for pure loops but may produce false positives in cases where:

- A tool genuinely needs a second attempt (e.g. transient 503 from an external API called via bash).
- The model intentionally re-runs the same check after an intermediate step (the inputs happen to be identical).

**Mitigation:** The detector requires that both calls are **failed** (error-pattern matched or `is_error=true`). A successful call in between resets the counter. `MIN_REPEATS` is a constant that can be increased to `3` if false positives are observed.

---

## 4. Completion gate phrase matching may miss non-English or obfuscated signals

The completion-gate signal phrases are English-only:
```
'all tasks complete', 'task done', 'everything done', 'all done', 'implementation complete',
'i have completed all', 'setup complete', 'done', 'complete', 'finished'
```

Models that produce completion signals in other languages, or that phrase them unusually ("The implementation is now fully functional."), will not be detected.

**Mitigation:** The gate is a safety net, not the primary control. Claude Code itself is the final judge of task completion. The gate addresses the most common failure mode (explicit "Done." with failed tools), not all possible variants.

---

## 5. Guidance injection does not prevent the request from proceeding

All guidance is appended to `systemInstruction`. The request is still forwarded to Gemini. The model may ignore the guidance. There is no hard blocking of tool calls or refusal of responses.

**Design rationale:** Hard blocking would break the client in ways that are hard to recover from. The gateway is a protocol translator; behavioral enforcement is advisory. A future enhancement could add a `LOOP_FORCE_TEXT=1` mode that sets `toolConfig.functionCallingConfig.mode = 'NONE'` on persistent loops to hard-break the call.

---

## 6. `behavior-auditor.ts` runs on every request (Redis round-trip avoided by design)

The auditor is called in `request.ts` before the Gemini call. All checks are synchronous (pure functions over the message array) except `spec-validator.ts` which is also pure. There are no Redis reads or writes in the behavior auditor. The cost is one in-process message-array walk per request.

At 1000 messages × 4 checks this is still sub-millisecond on modern hardware. However, at very large message histories (10,000+ messages) the combined walk could add measurable latency.

**Mitigation:** `path-guard.ts` is already bounded to the last 20 messages. `loop-detector.ts` breaks early once the loop is confirmed. `spec-validator.ts` and `completion-gate.ts` walk the full array but are pure O(n) operations with no inner loops.

---

## 7. Tool name normalization is one-way from the gateway's perspective

`lib/transformers/tools.ts` sanitizes tool names (hyphens/dots → underscores) before sending to Gemini, and `lib/transformers/stream.ts` maps them back using the `originalToolNames` map stored in Redis. The behavior modules (`loop-detector`, `verification-engine`, `path-guard`, `completion-gate`, `spec-validator`) work on **original** Anthropic-format message history, so they see the original tool names (e.g. `write_file`, `bash`). This is correct.

However, if the Redis key `gemini:toolname:<id>` expires before the response is streamed back, the reverse lookup will use the sanitized name. This is an existing gap in the gateway (not introduced by behavior modules) but worth noting.

---

## 8. No integration tests against live Gemini

All 54 tests in `tests/behavioral-tests.ts` are unit tests using hand-crafted message arrays. There are no integration tests that fire a real Anthropic request through the gateway and observe Gemini's response. Edge cases in real model behavior (e.g. Gemini ignoring `systemInstruction` appended guidance) cannot be caught by unit tests.

**Mitigation:** The existing `test-gemini-tool-call.mjs` and `test-gemma.mjs` scripts can serve as manual smoke tests against a live key.
