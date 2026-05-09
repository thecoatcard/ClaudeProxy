# Bash Restriction Audit

## Summary
Current gateway restrictions around bash-like behavior are primarily guidance and verification controls, not hard command blocking. This is appropriate for an Anthropic-compatible translator that should preserve agent autonomy while reducing repeated failure loops.

## Classification Matrix

### SAFE TO RELAX

1. PathGuard `suspicious_chars` guidance severity in path fields (`lib/agent/path-guard.ts`):
   - Current behavior is advisory only (system guidance injection), not enforcement.
   - Safe relaxation: keep detection, but tune wording to avoid over-warning for legitimate glob/brace usage when routed through explicit shell command args.

2. Retry strategy prohibition text strictness (`lib/agent/retry-strategy.ts`):
   - Current behavior says "do not call identically" after failures.
   - Safe relaxation: allow one bounded retry for transient classes (`timeout`, upstream `5xx`) with required argument/context change checks.

### KEEP (RECOMMENDED)

1. Directory traversal / null-byte / empty-path detection (`lib/agent/path-guard.ts`):
   - These are high-signal indicators of invalid or unsafe path inputs.
   - Keep as-is (guidance-critical).

2. Completion gate evidence checks (`lib/agent/completion-gate.ts`):
   - Prevents "done" claims without successful tool evidence.
   - Keep as-is to avoid silent false completion.

3. Verification engine result classification (`lib/agent/verification-engine.ts`):
   - Maintains failure/success/uncertain state from tool_result content.
   - Keep as-is for translator correctness and loop prevention.

### DANGEROUS TO REMOVE

1. Loop detector + behavior auditor intervention (`lib/transformers/loop-detector.ts`, `lib/agent/behavior-auditor.ts`):
   - Removing this re-enables repeated failing command loops.

2. PathGuard checks for traversal/null-byte (`lib/agent/path-guard.ts`):
   - Removing these allows unsafe path shapes to flow without warning.

3. Tool-result verification heuristics (`lib/agent/verification-engine.ts`):
   - Removing this causes optimistic continuation after hard failures (e.g., ENOENT/EACCES), increasing cascading errors.

## Practical Recommendation
Use **targeted relaxation only**:

1. Keep all safety-critical detections.
2. Relax only advisory phrasing and retry strictness for transient failures.
3. Do not introduce hard command blocking at translator layer unless policy/compliance explicitly requires denylisting.

This preserves productive developer bash workflows while keeping correctness and safety rails in place.
