# FILES_CHANGED.md

## Added

- lib/agent/process-supervisor.ts
  - New generic long-running process detector and output analyzer for behavior-layer guidance.
  - Adds multi-ecosystem command intent detection and classification (`LONG_RUNNING_PROCESS`).
  - Adds startup output classification (`STARTED` / `FAILED` / `UNKNOWN`) with success-over-failure-over-exit-code priority.
  - Adds port-fallback recovery handling and environment-aware termination guidance.
  - Adds history assessment for interval-monitoring guidance injection.

- tests/process-supervisor.test.ts
  - New tests covering detection, output classification, port fallback semantics, and environment-aware kill guidance.

- PROCESS_SUPERVISOR_REPORT.md
  - Implementation and validation report for process supervisor behavior.

## Modified

- lib/agent/behavior-auditor.ts
  - Integrated long-running process assessment into behavior auditing pipeline.
  - Injects guidance for background execution + 30-second log monitoring policy.
  - Adds diagnostics fields for long-running process detection and current startup state.
