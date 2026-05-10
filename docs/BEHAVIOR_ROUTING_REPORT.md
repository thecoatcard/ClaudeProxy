# Behavioral Routing Report

**Phase 1 of the 8-Phase Focused Improvement Pass**

---

## Summary

Replaced the previous keyword-matching task router with a signal-based behavioral router. The new system extracts quantitative signals from the request body rather than scanning for specific words, eliminating false positives from natural-language overlap.

---

## Problem with Keyword Routing

The previous router used broad keyword matching (e.g., "analyze", "debug", "think") which caused:
- "analyze bug" → incorrectly routed to REASONING (high-cost Gemma model)
- "think about the approach" → REASONING  
- "explain the error" → REASONING
- Result: expensive model used for simple coding queries

---

## Behavioral Signals Extracted

| Signal | Source | Description |
|--------|--------|-------------|
| `toolCount` | `request.tools.length` | Number of tools defined |
| `toolVariety` | Unique tool name prefixes | Tool diversity |
| `codeDensity` | Code blocks + file paths + stack traces | Code content density |
| `executionDensity` | bash/write/edit keyword count | Execution intent |
| `multiFile` | Distinct file references ≥ 3 | Multi-file scope |
| `architectureSignal` | Schema/migration/scaffold/full-stack refs | Architecture work |
| `explicitReasoning` | Formal logic proof patterns only | Proof/deduction requests |
| `webSearch` | "search the web", "look up online" | Web search intent |
| `messageLength` | Text length | Size heuristic |

---

## Routing Rules (classifyFromBehavior)

| Task Type | Trigger Conditions |
|-----------|-------------------|
| `WEB_SEARCH` | `webSearch` signal |
| `REASONING` | `explicitReasoning` only (formal logic patterns) |
| `HEAVY_CODING` | toolCount ≥ 5, architectureSignal, multiFile, executionDensity ≥ 4, or (toolCount ≥ 2 and codeDensity ≥ 3), thinkingEnabled |
| `LIGHT_CODING` | codeDensity ≥ 1, toolCount ≥ 1, or executionDensity ≥ 1 |
| `CHAT` | detectIntent → TRIVIAL_CHAT (checked first) |
| `HEALTH_CHECK` | Explicit health/status keywords |
| `COMPACTION` | Explicit compaction keywords |

---

## REASONING Gate (Critical Fix)

REASONING now only triggers on explicit formal logic/proof patterns:

```
mathematical proof | formal proof | deductive reason | inductive reason |
abductive reason | probabilistic reason | contradiction analysis |
causal inference | chain-of-thought reason | bayesian reason |
counterfactual reason | logical deduction proof
```

**Patterns that do NOT trigger REASONING:**
- "analyze this bug" → LIGHT_CODING / HEAVY_CODING
- "think about the approach" → LIGHT_CODING / HEAVY_CODING
- "explain why this error occurs" → LIGHT_CODING / HEAVY_CODING
- "review my code" → LIGHT_CODING / HEAVY_CODING
- "can you reason about the tradeoffs" → LIGHT_CODING / HEAVY_CODING

---

## Bug Fixed: Trailing Word Boundary in REASONING Regex

The original regex `/\b(...|probabilistic\s+reason|...)\b/i` had a trailing `\b` that prevented matching `probabilistic reasoning` (where `reason` is followed by `ing`). Fixed by removing the trailing `\b`.

---

## Files Changed

- `lib/routing/task-router.ts` — Full behavioral rewrite; added `BehavioralSignals`, `extractBehavioralSignals()`, `classifyFromBehavior()`
- `tests/task-router.test.ts` — Updated for behavioral routing
- `tests/behavior-routing.test.ts` — NEW: 44 behavioral routing tests

---

## Test Results

- `tests/behavior-routing.test.ts`: 44/44 pass
- `tests/task-router.test.ts`: all pass
- No REASONING false positives for coding/analysis queries
