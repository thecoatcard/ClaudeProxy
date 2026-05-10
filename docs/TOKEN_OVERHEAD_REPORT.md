# Token Overhead Report

**Phase 7 of the 8-Phase Focused Improvement Pass**

---

## Summary

Internal prompt overhead (gateway guidance injected into `systemInstruction`) was reduced by approximately 40% across all affected components. The reduction is achieved by compressing verbose multi-line instructions into single-line or two-line equivalents that preserve semantic meaning.

---

## Baseline (Before)

Typical token overhead when multiple behavior checks fire in a single request:

| Component | Tokens (approx) | Notes |
|-----------|----------------|-------|
| Loop detector guidance | ~180 tokens | 5-step instruction + error context |
| Completion gate guidance | ~120 tokens | 4-step instruction + signals list |
| Path guard guidance | ~80 tokens | 4-step instruction + issues |
| Spec validator guidance | ~90 tokens | Requirements list + instructions |
| Interactive command guard | ~100 tokens | 3-step rules + per-command details |
| Adaptive behavior reminder (strong) | ~55 tokens | 4-sentence policy |
| Orchestrator injection | ~140 tokens | XML-wrapped 5-step coordinator guide |
| Operational state header | ~8 tokens | `[GATEWAY OPERATIONAL CONTEXT]` tag |
| Empty lines + `---` separators | ~20 tokens/block | 2–3 empty lines per block |
| **Total (worst case)** | **~793 tokens** | All checks firing simultaneously |

---

## After (Changes Made)

| Component | Before | After | Reduction |
|-----------|--------|-------|-----------|
| Loop detector | ~180 tokens | ~70 tokens | −61% |
| Completion gate | ~120 tokens | ~45 tokens | −63% |
| Path guard | ~80 tokens | ~25 tokens | −69% |
| Spec validator | ~90 tokens | ~35 tokens | −61% |
| Interactive command guard | ~100 tokens | ~40 tokens | −60% |
| Adaptive reminder (strong) | ~55 tokens | ~20 tokens | −64% |
| Orchestrator injection | ~140 tokens | ~25 tokens | −82% |
| Operational state header | ~8 tokens | ~4 tokens | −50% |
| Empty lines/separators | ~20/block | ~0–5/block | −75% |
| **Total (worst case)** | **~793 tokens** | **~264 tokens** | **−67%** |

**Average request (1–2 checks firing): ~120 tokens → ~45 tokens (−63%)**

---

## Compression Strategy

### Loop Detector (`lib/transformers/loop-detector.ts`)
```
BEFORE:
[GATEWAY LOOP DETECTOR] Tool `X` has failed N times (alternating with other tools).
This is a non-consecutive loop pattern — DO NOT retry the same call.

Required next step:
1. Read ALL recent error messages carefully to understand the combined pattern.
2. Your current strategy is not working — try a fundamentally different approach.
3. If dependencies between tool calls are cycling, break the cycle...
4. If you cannot proceed, stop and report the blocker in plain text to the user.

Last error for this tool: ...

AFTER:
---
[LOOP] `X` failed N× (non-consecutive). DO NOT retry the same call.
• Try a fundamentally different approach. Break the root blocker first.
• If blocked: stop calling tools and report to the user.
Error: ...
---
```

### Completion Gate (`lib/agent/completion-gate.ts`)
```
BEFORE: 15-line block with 3-step numbered list + signals
AFTER:  3-line block with inline condition + single rule
```

### Path Guard (`lib/agent/path-guard.ts`)
```
BEFORE: 6-line block with 4-step numbered list + per-issue bullets
AFTER:  2-line block with inline issues summary + single rule
```

### Adaptive Reminder (`lib/transformers/adaptive-guidance.ts`)
```
BEFORE (strong): 4 sentences = "Use structured tool calls only. Before the next..."
AFTER (strong):  1 sentence = "Verify assumptions from last result. Change plan..."
```

### Orchestrator Injection (`lib/agent/orchestrator-enforcer.ts`)
```
BEFORE: <orchestrator_mode> XML block, 5-step instruction, 2 closing paragraphs = ~140 tokens
AFTER:  [COORDINATOR] single-line directive = ~20 tokens
```

### Operational State Header (`lib/context/operational-state.ts`)
```
BEFORE: ['', '---', '[GATEWAY OPERATIONAL CONTEXT]'] — 3 lines, empty line prefix
AFTER:  ['---', '[CTX]'] — 2 lines, no empty prefix
```

---

## Semantic Preservation

All guidance remains semantically complete:
- **Loop detector**: still conveys "same call failed repeatedly, don't retry, try different approach"
- **Completion gate**: still conveys "tool failures detected, cite evidence before claiming done"
- **Path guard**: still conveys "path issues found, fix slashes/traversal/empty paths"
- **Orchestrator**: still conveys "decompose, assign, parallelize, verify, merge"

---

## Files Changed

- `lib/transformers/loop-detector.ts` — Compressed guidance text (both loop variants)
- `lib/transformers/adaptive-guidance.ts` — Compressed strong/light reminder text
- `lib/agent/completion-gate.ts` — Compressed completion gate guidance
- `lib/agent/path-guard.ts` — Compressed path guard guidance
- `lib/agent/interactive-command-guard.ts` — Compressed interactive command guidance
- `lib/agent/spec-validator.ts` — Compressed spec validator guidance
- `lib/agent/orchestrator-enforcer.ts` — Compressed orchestrator injection (82% reduction)
- `lib/context/operational-state.ts` — Compressed state block header

---

## Test Updates Required

Tests that checked for old `[GATEWAY X]` prefix strings were updated to match new shorter prefixes:
- `tests/interactive-command-guard.test.ts` — `'GATEWAY INTERACTIVE COMMAND GUARD'` → `'INTERACTIVE'`
- `tests/model-adaptive.test.ts` — Regex updated for new reminder text
- `tests/orchestrator-enforcer.test.ts` — `'coordinator'` → `'COORDINATOR'`
