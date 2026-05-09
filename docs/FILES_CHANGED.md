# FILES_CHANGED.md

---

## Session: Orchestrator Enforcement + Model Router Fix (2026-05-09)

### New Files

- **lib/agent/task-complexity.ts** — Classifies requests into TRIVIAL/NORMAL/COMPLEX/MULTI_STAGE; detects explicit orchestrator override commands.

- **lib/agent/orchestrator-enforcer.ts** — Gateway enforcement layer; injects coordinator system prompt; creates subagent task stubs; finalizes tasks after model call.

- **lib/agent/subagent-memory.ts** — Redis-backed subagent task store with 24h TTL; tracks id/owner/status/dependencies/artifacts.

- **tests/task-complexity.test.ts** — 19 tests covering all complexity levels and override commands.

- **tests/orchestrator-enforcer.test.ts** — 10 tests for orchestrator prepare/finalize flow.

- **tests/subagent-memory.test.ts** — 9 tests for Redis roundtrip, status updates, parent indexing.

- **tests/model-router-imports.test.ts** — 9 tests validating all public model-router exports.

- **jest.config.ts** — Jest + ts-jest configuration for the project.

- **docs/ORCHESTRATOR_ENFORCEMENT_REPORT.md** — Full orchestrator architecture and success criteria.

- **docs/MODEL_ROUTER_FIX_REPORT.md** — Model router fix notes and import verification.

### Modified Files

- **lib/model-router.ts** — Added `getRoutingRegistry` as public alias for `getEffectiveRoutingRegistry`.

- **app/api/v1/messages/route.ts** — Imported and wired `prepareOrchestration` / `finalizeOrchestration`; streaming and non-streaming paths both use enriched orchestrated body.

- **package.json** — Added `test` and `test:new` scripts; added jest/ts-jest dev dependencies.

- **docs/TEST_RESULTS.md** — Appended new test suite results.

---

## Session: Routing Persistence + Adaptive Model Rotation

### New Files

- **lib/routing/task-router.ts** — Task classification + model chains (`REASONING`, `HEAVY_CODING`, `LIGHT_CODING`, `HEALTH_CHECK`, `COMPACTION`).

- **lib/routing/default-model-routing.json** — Local default registry used when Redis is unavailable.

- **tests/routing-registry.test.ts** — Redis precedence and dashboard-save runtime effect tests.

- **tests/routing-cache.test.ts** — Version bump, force reload, in-memory invalidation tests.

- **tests/task-router.test.ts** — Task classification and model-chain selection tests.

- **MODEL_ROUTING_FIX_REPORT.md** — Root cause and end-to-end fix notes.

- **ROUTING_CACHE_REPORT.md** — Cache invalidation strategy and behavior.

- **TASK_ROUTING_REPORT.md** — Task-aware routing strategy and task/model mapping.

### Modified Files

- **lib/model-router.ts** — Rebuilt routing pipeline:
  Redis → local JSON → hardcoded fallback priority,
  versioned registry cache, `forceReloadRouting()`,
  `saveRoutingRegistry()`, `getRoutingDiagnostics()`,
  version-scoped sticky key (`route:last:v{version}:...`),
  task-aware routing integration.

- **app/api/admin/models/route.ts** — Uses centralized router save/load functions and returns live reload diagnostics.

- **app/dashboard/models/page.tsx** — Save confirmation + live routing status panel (source/version/alias count).

- **lib/retry-engine.ts** — Version-aware sticky persistence and explicit fallback-reason logs.

- **app/api/v1/messages/route.ts** — Added routing resolution logs (requested/resolved/source/task/version) and activity telemetry enrichment.

- **lib/activity.ts** — Added optional routing telemetry fields.

---

## Session: Behavior System Upgrade — Phases 1–9

### New Files

- **lib/context/operational-state.ts** — Upgraded to v3 (new types: SubagentTask, DependencyRecord; new fields: workspace_root, current_working_root, known_directories, dependency_versions, resolved_patterns, active_subagent_tasks; new functions: detectCwdFromText, extractDependencyVersions).

- **lib/agent/artifact-verifier.ts** — Verifies artifact existence from OperationalState before write/build operations. Types: ArtifactConfidence. Functions: verifyArtifact, buildVerificationGuidance, extractPathsForVerification.

- **lib/agent/background-task-tracker.ts** — Enforces task ordering — background tasks (npm install, docker build) must complete before dependent operations. Functions: checkTaskBlockers, buildDependencyGuidance, registerBackgroundTask.

- **lib/agent/dependency-compatibility.ts** — Detects known-breaking package versions (Prisma 7, Tailwind v4, Next 15, etc.) before install. 10-entry registry, risk levels, safe version suggestions.

- **lib/agent/web-recovery.ts** — Error classification + official-docs search query generation. 11 error classes, repeat-aware search triggering, priority domain routing.

- **lib/agent/contradiction-detector.ts** — A→B→A oscillation loop detection across message history. Tracks opposing operations (add/remove, install/uninstall, write/delete) on the same target.

- **lib/reasoning/gemma-helper.ts** (new directory `lib/reasoning/`) — Gemma 4 lightweight reasoning helper. Tasks: compress_state, analyze_error, plan_recovery, check_dependency, explain_contradiction. 8-second timeout, graceful failure.

- **tests/contradiction-detector.test.ts** — 13 tests covering loop detection and guidance generation.

- **tests/dependency-compatibility.test.ts** — 17 tests covering version parsing, risk flagging, safe versions.

- **tests/web-recovery.test.ts** — 16 tests covering error classification and search query generation.

- **tests/gemma-helper.test.ts** — 9 tests covering module exports and graceful failure behavior.

- **OPERATIONAL_CONTEXT_V2_REPORT.md** — v3 schema, new types, detection functions, Redis key change.

- **WEB_RECOVERY_REPORT.md** — Error class registry, detection logic, integration points.

- **DEPENDENCY_COMPATIBILITY_REPORT.md** — Breaking change registry, detection logic, test coverage.

### Modified Files

- **lib/agent/behavior-auditor.ts** — Integrated 3 new checks (7, 8, 9): contradiction detection, dependency compatibility scanning, web recovery guidance. Added 4 new diagnostics fields: contradictionDetected, contradictionLoops, dependencyRisks, webRecoveryTriggered. Helper functions: extractInstallCommands, extractToolErrors, buildErrorRepeatMap.

---

## Session: Web Search + Operational Context

### New Files

- **lib/tools/web-search.ts** — Anthropic web_search tool compatibility layer for Gemini backend:
  `isWebSearchTool`, `partitionWebSearchTools`, `WebSearchConfig`, `WEB_SEARCH_FUNCTION_DECLARATION`,
  `executeWebSearch`, `braveSearch`, `tavilySearch`, `serpApiSearch`,
  `normalizeSearchResults`, `buildSearchFunctionResponse`.

- **lib/tools/search-executor.ts** — Multi-turn Gemini search loop:
  `runWithWebSearch` (up to 5 turns), `injectWebSearchTool`, `removeWebSearchDeclaration`.

- **lib/context/operational-state.ts** — Persistent operational context memory (Redis):
  `OperationalState` schema (version 2), shell/artifact/failure/background-task detection,
  `updateStateFromMessages`, `loadOperationalState`, `saveOperationalState`,
  `buildOperationalGuidance`, `operationalStateKey`, `defaultOperationalState`.

- **tests/web-search.test.ts** — 24 unit tests for web search layer.

- **tests/operational-context.test.ts** — 20 unit tests for operational state system.

- **WEB_SEARCH_SUPPORT_REPORT.md** — Architecture, provider config, streaming behaviour, env vars.

- **OPERATIONAL_CONTEXT_REPORT.md** — Schema, detection rules, guidance format, Redis key structure.

### Modified Files

- **lib/transformers/tools.ts** — Filters `web_search` from Gemini FunctionDeclarations.

- **lib/transformers/request.ts** — Returns `{geminiBody, webSearchConfig}`; wires operational state
  load/update/inject/save; adds opStateStore Redis adapter; imports web-search and operational-state.

- **app/api/v1/messages/route.ts** — Non-streaming web search path via `runWithWebSearch`.

- **lib/transformers/stream.ts** — Streaming web search pre-execution; synthetic SSE emission.

---

## Session: Prior work (abbreviated)

## Added

- lib/agent/process-supervisor.ts
- tests/process-supervisor.test.ts
- PROCESS_SUPERVISOR_REPORT.md

## Modified

- lib/agent/behavior-auditor.ts
  - Integrated long-running process assessment, interactive command guard.


### New Files

- **lib/tools/web-search.ts** — Anthropic web_search tool compatibility layer for Gemini backend:
  `isWebSearchTool`, `partitionWebSearchTools`, `WebSearchConfig`, `WEB_SEARCH_FUNCTION_DECLARATION`,
  `executeWebSearch`, `braveSearch`, `tavilySearch`, `serpApiSearch`,
  `normalizeSearchResults`, `buildSearchFunctionResponse`.

- **lib/tools/search-executor.ts** — Multi-turn Gemini search loop:
  `runWithWebSearch` (up to 5 turns), `injectWebSearchTool`, `removeWebSearchDeclaration`.

- **lib/context/operational-state.ts** — Persistent operational context memory (Redis):
  `OperationalState` schema (version 2), shell/artifact/failure/background-task detection,
  `updateStateFromMessages`, `loadOperationalState`, `saveOperationalState`,
  `buildOperationalGuidance`, `operationalStateKey`, `defaultOperationalState`.

- **tests/web-search.test.ts** — 24 unit tests for web search layer.

- **tests/operational-context.test.ts** — 20 unit tests for operational state system.

- **WEB_SEARCH_SUPPORT_REPORT.md** — Architecture, provider config, streaming behaviour, env vars.

- **OPERATIONAL_CONTEXT_REPORT.md** — Schema, detection rules, guidance format, Redis key structure.

### Modified Files

- **lib/transformers/tools.ts** — Filters `web_search` from Gemini FunctionDeclarations.

- **lib/transformers/request.ts** — Returns `{geminiBody, webSearchConfig}`; wires operational state
  load/update/inject/save; adds opStateStore Redis adapter; imports web-search and operational-state.

- **app/api/v1/messages/route.ts** — Non-streaming web search path via `runWithWebSearch`.

- **lib/transformers/stream.ts** — Streaming web search pre-execution; synthetic SSE emission.

---

## Session: Prior work (abbreviated)

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
