# Dynamic Racing Report

**Phases 2 and 3 of the 8-Phase Focused Improvement Pass**

---

## Summary

Replaced static key/model racing counts with task-type-adaptive racing. Racing intensity scales with task complexity — cheap tasks use fewer parallel resources; expensive tasks use more.

---

## Phase 2: Dynamic Key Racing

### Rules (`getDynamicKeyCount`)

| Task Type | Keys Raced | Rationale |
|-----------|-----------|-----------|
| CHAT | 1 | Trivial — no parallelism needed |
| HEALTH_CHECK | 1 | Single-key is enough |
| COMPACTION | 1 | Sequential summarization |
| LIGHT_CODING | 2 | Moderate redundancy |
| REASONING | 2 | Formal proof requests |
| WEB_SEARCH | 2 | Search + model call |
| HEAVY_CODING | 3 | Maximum throughput |
| any (overload) | 3 | All keys under overload pressure |

### Implementation

```typescript
export function getDynamicKeyCount(taskType: TaskType, isOverload = false): number {
  if (isOverload) return 3;
  switch (taskType) {
    case 'CHAT': case 'HEALTH_CHECK': case 'COMPACTION': return 1;
    case 'LIGHT_CODING': case 'REASONING': case 'WEB_SEARCH': return 2;
    case 'HEAVY_CODING': return 3;
    default: return 2;
  }
}
```

---

## Phase 3: Dynamic Model Racing

### Rules (`getDynamicModelRaceConfig`)

| Task Type | Enabled | Models Raced |
|-----------|---------|-------------|
| CHAT | ✗ | 1 (no race) |
| HEALTH_CHECK | ✗ | 1 |
| COMPACTION | ✗ | 1 |
| REASONING | ✗ | 1 (Gemma only — racing defeats thinking) |
| LIGHT_CODING | ✓ | 2 models |
| WEB_SEARCH | ✓ | 2 models |
| HEAVY_CODING | ✓ | 3 models |
| any (overload) | ✓ | 3 models |

### Model Pool Compliance

`getModelsForRace(taskType, count)` selects models from the task's assigned chain. All models are validated against `ALLOWED_MODEL_POOL` (8 models). No model outside the pool can be selected.

---

## Files Changed

- `lib/racing/key-racer.ts` — Added `getDynamicKeyCount()`
- `lib/racing/model-racer.ts` — Added `getDynamicModelRaceConfig()`, `getModelsForRace()`
- `tests/dynamic-key-racing.test.ts` — NEW: key racing tests for all task types
- `tests/dynamic-model-racing.test.ts` — NEW: model racing tests + pool compliance

---

## Test Results

- `tests/dynamic-key-racing.test.ts`: all pass
- `tests/dynamic-model-racing.test.ts`: all pass
