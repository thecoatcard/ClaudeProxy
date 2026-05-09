# MODEL_ADAPTIVE_REPORT.md

## Scope

This pass implemented translator-only, model-adaptive behavior policies for the Anthropic-to-Gemini gateway.

No architecture changes were made:
- no filesystem APIs
- no shell execution
- no tool runtime
- Edge runtime compatibility preserved

## Implemented Phases

### Phase 1: Model capability profiles

Added [lib/models/capability-profile.ts](lib/models/capability-profile.ts).

Defined normalized 0-1 capability scores for:
- gemini-2.5-flash
- gemini-2.5-flash-lite
- gemini-3-flash-preview
- gemini-3.1-flash-lite-preview
- gemini-flash-latest
- gemini-flash-lite-latest
- gemma-4-31b-it
- gemma-4-26b-a4b-it

Scored capabilities:
- tool_adherence
- structured_output_reliability
- retry_quality
- spec_fidelity
- completion_honesty
- context_retention
- compaction_tolerance

### Phase 2: Adaptive loop policy

Added [lib/transformers/adaptive-loop-policy.ts](lib/transformers/adaptive-loop-policy.ts).

Integrated into [lib/transformers/loop-detector.ts](lib/transformers/loop-detector.ts).

Behavior:
- strong tool models use `minRepeats = 3`
- weaker/lite models use `minRepeats = 2`
- weaker models also get stronger loop-break guidance text

### Phase 3: Adaptive action recovery

Added [lib/transformers/adaptive-action-policy.ts](lib/transformers/adaptive-action-policy.ts).

Integrated into:
- [lib/transformers/response.ts](lib/transformers/response.ts)
- [lib/transformers/stream.ts](lib/transformers/stream.ts)

Behavior:
- weak tool models: aggressive recovery of embedded `[Action: ...]` text
- stronger tool models: minimal fallback recovery only when action-text is effectively standalone

### Phase 4: Adaptive compaction

Added [lib/transformers/adaptive-compaction-policy.ts](lib/transformers/adaptive-compaction-policy.ts).

Integrated into:
- [lib/transformers/request.ts](lib/transformers/request.ts)
- [lib/transformers/compaction.ts](lib/transformers/compaction.ts)

Behavior:
- strong context models compact later
- weak context models compact earlier but keep more recent turns and richer summaries
- failure anchoring depth is model-adaptive

### Phase 5: Adaptive prompt strength

Added [lib/transformers/adaptive-guidance.ts](lib/transformers/adaptive-guidance.ts).

Integrated into [lib/agent/behavior-auditor.ts](lib/agent/behavior-auditor.ts).

Behavior:
- stronger models receive shorter corrective reminders
- weaker models receive explicit guardrails such as:
  - use structured tool calls only
  - verify assumptions before the next action
  - do not repeat failed calls unchanged

### Phase 6: Adaptive tool result envelope

Integrated in [lib/transformers/request.ts](lib/transformers/request.ts).

Tool results sent back to Gemini are now standardized as:
- success: `{ ok: true, result: ... }`
- failure: `{ ok: false, error: ... }`

This preserves error semantics consistently across model families without changing protocol architecture.

## Control Path

Adaptive behavior is applied only in existing translator control points:
- request transform
- loop detector
- behavior auditor
- action-text recovery
- compaction policy

No new runtime surfaces were introduced.

## Validation

Added [tests/model-adaptive.test.ts](tests/model-adaptive.test.ts) covering:
- profile selection
- adaptive loop thresholds
- adaptive compaction policies
- adaptive guidance strength
- adaptive recovery behavior

Full validation passed:
- `npx tsc --noEmit`
- `npx tsx --test tests/behavioral-tests.ts tests/tool-structure.test.ts tests/context-compaction.test.ts tests/model-adaptive.test.ts`

Results:
- tests: 71
- pass: 71
- fail: 0

## Success Check

- [x] behavior changes by model
- [x] stronger models get lighter intervention
- [x] weaker models get stronger guardrails
- [x] tool reliability improves across model families
