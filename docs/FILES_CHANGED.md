# FILES_CHANGED.md

---

## JS/HTML Tool Reliability Hardening — Phases 1–8

### New Source Files

| File | Phase | Purpose |
|---|---|---|
| `lib/tools/structure-aware-patch.ts` | 1, 2, 8 | AST/DOM-aware patch strategy + snapshot hash guidance |
| `lib/agent/tool-reliability-guard.ts` | 4, 6 | Platform shell guard + generated Python patch validation |

### Modified Source Files

| File | Phases | Changes |
|---|---|---|
| `lib/transformers/loop-detector.ts` | 1, 2, 3, 8 | Same-tool/same-failure loop detection; JS/HTML strategy and snapshot guidance |
| `lib/tools/tool-failure-memory.ts` | 2 | Added snapshot hash record/load/freshness APIs |
| `lib/transformers/request.ts` | 2 | Persist read snapshots and mark stale edit failure reasons |
| `lib/agent/behavior-auditor.ts` | 4, 6 | Platform shell patch risk guidance + Python patch validation guidance |
| `lib/agent/subagent-executor.ts` | 5 | Empty subagent result detection and fallback retry |

### New Test Files

| File | Tests | Phases |
|---|---|---|
| `tests/js-edit-reliability.test.ts` | 3 | 1, 3 |
| `tests/html-edit-reliability.test.ts` | 3 | 1, 8 |
| `tests/windows-shell-fallback.test.ts` | 3 | 4 |
| `tests/empty-agent-result.test.ts` | 2 | 5 |
| `tests/snapshot-freshness.test.ts` | 4 | 2 |

### New Documentation

| File | Contents |
|---|---|
| `docs/TOOL_RELIABILITY_REPORT.md` | Full phase-by-phase reliability hardening summary |
| `docs/JS_PATCH_REPORT.md` | JS/TS patch reliability deep-dive |
| `docs/HTML_PATCH_REPORT.md` | HTML selector-specialized patching summary |
| `docs/FILES_CHANGED.md` | This file (updated) |
| `docs/TEST_RESULTS.md` | Updated to 83/83 suites and 944 tests |

---

## Tool Behavior Hardening — 10 Phases (Claude Code-Like Tool Flow)

### New Source Files

| File | Phase | Purpose |
|---|---|---|
| `lib/tools/edit-failure-classifier.ts` | 2, 8 | Pure classification of edit tool failures; path/CRLF normalization |
| `lib/tools/edit-recovery.ts` | 3, 4, 5 | Claude Code-like edit recovery guidance (REREAD → WRITE → ESCALATE) |
| `lib/tools/tool-failure-memory.ts` | 6 | Redis-backed tool failure tracking per (session, tool, file) |

### Modified Source Files

| File | Phases | Changes |
|---|---|---|
| `lib/transformers/loop-detector.ts` | 1, 8 | Added `detectEditStagnation()`; Phase 8 path/CRLF normalization |
| `lib/agent/behavior-auditor.ts` | 1, 3, 7 | Phase 0 stagnation check; `[LOOP_BREAKER]` injection at failureCount≥3 |
| `lib/transformers/request.ts` | 6 | Fire-and-forget `recordToolFailure` after behavior audit |

### New Test Files

| File | Tests | Phases |
|---|---|---|
| `tests/edit-failure-classifier.test.ts` | 48 | 2, 8 |
| `tests/edit-recovery.test.ts` | 36 | 3, 4, 5 |
| `tests/tool-loop-detector.test.ts` | 22 | 1, 7, 8 |
| `tests/tool-failure-memory.test.ts` | 19 | 6 |

### New Documentation

| File | Contents |
|---|---|
| `docs/TOOL_SUPERVISION_REPORT.md` | All 8 phases overview |
| `docs/EDIT_RECOVERY_REPORT.md` | Phases 3/4/5 deep-dive |
| `docs/TOOL_LOOP_FIX_REPORT.md` | Phases 1/7 loop detection and breaker |
| `docs/FILES_CHANGED.md` | This file (updated) |
| `docs/TEST_RESULTS.md` | Updated with 929 passing tests |

---

## Security Hardening Pass — Phases 1–8

### New Source Files

| File | Phase | Purpose |
|---|---|---|
| `lib/session/session-identity.ts` | 1 | Nonce-based hard session identity |
| `lib/session/workspace-fingerprint.ts` | 2 | Multi-source workspace path fingerprinting |
| `lib/session/session-binding.ts` | 4 | Session binding (conversationId ↔ userId + workspace) |

### Modified Source Files

| File | Phases | Changes |
|---|---|---|
| `lib/context/hydration-guard.ts` | 3, 4 | `workspacesMatch()` null-null policy; new skip reasons; binding gate |
| `lib/transformers/request.ts` | 1, 2, 4, 5 | `finalizeConversationId()`; workspace fingerprint; session binding; await critical writes |
| `lib/tool-archive.ts` | 6 | `buildArchiveMissPlaceholder()`, `recoverArchivedOutput()` |
| `lib/retry-engine.ts` | 7, 8 | `getFastPathRaceTimeoutMs(taskType)`; `recordModelHealth` import; health-aware routing call |
| `lib/recovery/overload-recovery.ts` | 8 | `ModelHealthRecord`, `recordModelHealth`, `getHealthAwareFallbackChain`, `getNextFallbackModelHealthAware` |

### New Test Files

| File | Tests | Phase |
|---|---|---|
| `tests/session-identity.test.ts` | 14 | 1 |
| `tests/workspace-fingerprint.test.ts` | 28 | 2 |
| `tests/hydration-null-policy.test.ts` | 12 | 3, 4 |
| `tests/session-binding.test.ts` | 16 | 4 |
| `tests/archive-recovery.test.ts` | 13 | 6 |
| `tests/dynamic-key-timeout.test.ts` | 15 | 7 |
| `tests/provider-health-routing.test.ts` | 15 | 8 |

### Modified Test Files

| File | Changes |
|---|---|
| `tests/context-isolation.test.ts` | 7 tests updated: Phase 3 null workspace expectations |
| `tests/integration-pipeline.test.ts` | 1 test updated: null workspace triggers stale key deletion |

### New Documentation

| File | Contents |
|---|---|
| `docs/SESSION_HARDENING_REPORT.md` | Phase 1–8 full report |
| `docs/WORKSPACE_FINGERPRINT_REPORT.md` | Phase 2 deep-dive |
| `docs/REDIS_INTEGRITY_REPORT.md` | Phase 5 critical write classification |
| `docs/ARCHIVE_RECOVERY_REPORT.md` | Phase 6 miss recovery |
| `docs/HEALTH_ROUTING_REPORT.md` | Phase 8 health-aware routing |
| `docs/FILES_CHANGED.md` | This file |
| `docs/TEST_RESULTS.md` | Updated with Phase 9 results |

---

## Context Isolation Fix — Hydration Leakage Fix (Previous)

### New Files

| File | Purpose |
|------|---------|
| `lib/context/hydration-guard.ts` | Multi-gate hydration safety layer (all gate logic, pure functions) |
| `tests/context-isolation.test.ts` | 20 tests covering all hydration gates |
| `docs/CONTEXT_ISOLATION_REPORT.md` | Full architecture report |
| `docs/HYDRATION_FIX_REPORT.md` | Phase-by-phase fix report |

### Modified Files

| File | Changes |
|------|---------|
| `lib/transformers/request.ts` | Wired hydration guard before emergency state, marker hydration, rolling summary, and operational state injection. Imported `operationalStateKey`, `extractWorkspaceRootFromSystem`, guard functions. |

---

## Task 13 — Gateway Stabilization

- `app/api/v1/messages/route.ts` — Removed live orchestrator prepare/run/finalize calls; added request-scoped auth, routing, transform, stream, and completion timings.
- `lib/agent/task-complexity.ts` — Made legacy orchestration opt-in via `ENABLE_GATEWAY_ORCHESTRATOR=true`.
- `lib/agent/orchestrator-enforcer.ts` — Legacy orchestrator now returns an inert context unless explicitly enabled.
- `lib/retry-engine.ts` — Key racing defaults to one key; model racing defaults off; added request-scoped model call timing.
- `lib/transformers/request.ts` — Added behavior audit, retrieval/context lookup, compaction, operational memory, and metadata timing events; raised compaction token thresholds.
- `lib/transformers/stream.ts` — Threads request IDs through stream transformation and retry execution.
- `lib/transformers/compaction.ts` — Compaction now triggers from token pressure, not message count alone.
- `lib/routing/task-router.ts` — Removed generic reasoning keyword routing to Gemma for ordinary user requests.
- `lib/logging/event-logger.ts` — Added `RETRIEVAL` and `MODEL_CALL` event categories.
- `lib/logging/timeline-builder.ts` — Added timeline handling for retrieval/model-call events.
- `app/dashboard/*` — Replaced duplicated per-page auth fetches with shared `useAuth()` context.
- `tests/*` — Updated orchestration and compaction tests for default-off orchestration and token-pressure-only compaction.
- `docs/GATEWAY_STABILIZATION_REPORT.md` — Added complete architecture and flow audit.

---

## Task 12 — Build Fix

- `app/dashboard/page.tsx` — Restored missing `<LineChart>` JSX
- `lib/logging/event-logger.ts` — Added `KEY_RACE`, `MODEL_RACE` to `EventCategory`
- `app/api/admin/logs/route.ts` — Fixed auth logic, null safety, scan call
- `lib/redis/client.ts` — Added `scan()` to RedisClient, `lrange()` to RedisPipeline
- `tests/fallback-overload.test.ts` — Fixed `compactedBody` → `compacted`
- `tests/incremental-embedding.test.ts` — Added `mtime` to FileEntry mock
- `tests/memory-integration.test.ts` — Added `mtime` to FileEntry mock
- `tests/project-memory-location.test.ts` — Fixed NODE_ENV assignment

---

## Session: Embedding Memory Architecture Fix

### New Files

| File | Purpose |
|------|---------|
| `lib/memory/project-memory-path.ts` | Canonical .coatcard path resolution using workspace root |
| `lib/memory/redis-vector-store.ts` | Redis-backed primary vector storage with workspace isolation |
| `lib/reasoning/gemma-helper.ts` | Gemma reasoning helper (restored) with Redis caching |
| `tests/redis-vector-store.test.ts` | 11 tests for Redis vector store |
| `tests/freshness-ranking.test.ts` | 11 tests for freshness ranking |
| `tests/adaptive-confidence.test.ts` | 11 tests for adaptive threshold |
| `tests/rename-detection.test.ts` | 8 tests for rename detection |
| `tests/filesystem-optional.test.ts` | 7 tests for fs-optional ingestion |
| `tests/gemma-helper.test.ts` | 9 tests for Gemma reasoning |
| `tests/project-memory-location.test.ts` | 19 tests for path resolution |
| `docs/PROJECT_MEMORY_LOCATION_FIX_REPORT.md` | Path fix report |
| `docs/REDIS_VECTOR_STORE_REPORT.md` | Vector store report |
| `docs/EMBEDDING_ARCHITECTURE_FIX_REPORT.md` | Full architecture report |

### Modified Files

| File | Changes |
|------|---------|
| `lib/memory/vector-index.ts` | Canonical paths, optional disk, dynamic fs import |
| `lib/memory/file-ingestion.ts` | Filesystem-optional, workspace root, `supportsFileIngestion()` |
| `lib/memory/incremental-embedding.ts` | Rename detection, canonical paths, optional disk |
| `lib/memory/retrieval-pipeline.ts` | Freshness ranking, adaptive threshold, retrieval caching |
| `lib/memory/summary-memory.ts` | Canonical paths, optional disk |

---

## Session: Dashboard + Overload Root Cause Fixes

### Modified Files

| File | Changes |
|------|---------|
| `lib/recovery/overload-recovery.ts` | Cooldown 30s→10s, `RECOVERY_CHAIN_SIZE` export, double-cooldown fix |
| `lib/retry-engine.ts` | Fast-exit uses `RECOVERY_CHAIN_SIZE` instead of hardcoded count |
| `lib/agent/orchestrator-enforcer.ts` | `markOrchestrationRunning()`, performance recording, latency tracking |
| `app/api/v1/messages/route.ts` | `markOrchestrationRunning` call, latency passed to `finalizeOrchestration` |
| `app/api/admin/orchestrator/route.ts` | Added new Gemini model IDs |
| `app/dashboard/orchestrator/page.tsx` | Removed admin key input, cookie-based auth |

---

## Session: Embedding Memory System + Dead Code Cleanup

### New Files

| File | Purpose |
|------|---------|
| `lib/memory/embedding-engine.ts` | Google text-embedding-004 integration |
| `lib/memory/file-ingestion.ts` | Project file scanner for embedding |
| `lib/memory/vector-index.ts` | In-memory vector index with disk persistence |
| `lib/memory/incremental-embedding.ts` | SHA-256 hash-based change detection |
| `lib/memory/summary-memory.ts` | Task + error summary embedding |
| `lib/memory/retrieval-pipeline.ts` | Query → embed → search → inject pipeline |
| `lib/memory/context-priority.ts` | Priority-ordered context merging |
| `lib/memory/subagent-retrieval.ts` | Role-scoped retrieval for subagents |
| `tests/embedding-engine.test.ts` | 11 tests |
| `tests/vector-index.test.ts` | 11 tests |
| `tests/incremental-embedding.test.ts` | 10 tests |
| `tests/retrieval-pipeline.test.ts` | 11 tests |
| `tests/context-priority.test.ts` | 9 tests |
| `tests/memory-integration.test.ts` | 8 tests (integration) |
| `.coatcard/` directory structure | Project-scoped persistent memory |
| `docs/EMBEDDING_MEMORY_REPORT.md` | Full system report |
| `docs/FILES_REMOVED.md` | Dead code removal log |

### Modified Files

| File | Changes |
|------|---------|
| `lib/model-router.ts` | Removed duplicate `normalizeModelName()`; imports from capability-profile |
| `.gitignore` | Added `.coatcard/` exclusions |

### Removed Files

| File | Reason |
|------|---------|
| `lib/reasoning/gemma-helper.ts` | Dead — 6 unused exports |
| `tests/gemma-helper.test.ts` | Test for dead code |
| `src/` directory | Stale duplicate |
| `store/auth.ts` | Unused Zustand store |
| `test-compaction-fixed.ts` | Dev-only script |
| `test-gemini-history.mjs` | Dev-only script |
| `test-gemini-tool-call.mjs` | Dev-only script |
| `test-gemma.mjs` | Dev-only script |
| `lib/scripts/` | Empty directory |
| `scratch/` | Empty directory |

---

## Session: Overload Recovery Pipeline

### New Files

| File | Purpose |
|------|---------|
| `lib/recovery/overload-recovery.ts` | Central overload recovery module |
| `tests/overload-recovery.test.ts` | 27 tests |
| `tests/key-rotation-overload.test.ts` | 4 tests |
| `tests/fallback-overload.test.ts` | 4 tests |
| `tests/subagent-resume.test.ts` | 6 tests |

### Modified Files

| File | Changes |
|------|---------|
| `lib/retry-engine.ts` | Wired overload recovery pipeline at 4 integration points |
| `lib/agent/orchestrator-enforcer.ts` | Added `resumeOrchestratedExecution()` |
| `tests/orchestrator-dedupe.test.ts` | Removed unused import |

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

---

## Task 14 � Full Gateway Optimization & Compatibility Refactor (2026-05-10)

### New Files Created
- __mocks__/nanoid.js � CJS-compatible nanoid mock for Jest (fixes ESM parse error)
- docs/FULL_CODEBASE_AUDIT.md � Full audit findings
- docs/ARCHITECTURE_FIXES.md � Architecture fixes applied
- docs/PERFORMANCE_REPORT.md � Performance analysis and recommendations
- docs/COMPATIBILITY_REPORT.md � Anthropic API compatibility matrix
- docs/TEST_RESULTS.md � Updated test results

### Modified Files

#### Configuration
- jest.config.ts � Added moduleNameMapper for nanoid (ESM) and .js extension resolution

#### Routing & Model Pool
- lib/routing/task-router.ts
  - Added ALLOWED_MODEL_POOL Set (exported) � strict 8-model pool
  - Added REASONING chain: gemma-4-31b-it primary
  - Fixed LIGHT_CODING chain: gemini-3-flash-preview primary (was gemini-2.5-flash-lite)
  - Fixed COMPACTION chain: gemma-4-26b-a4b-it primary (was gemma-4-31b-it)
  - Restored REASONING classification with high-precision keyword patterns
  - Added ALLOWED_MODEL_POOL inline comments
- lib/model-router.ts
  - Added enforceModelPool() � filters chains to allowed pool
  - Added enforceRoutePool() � validates primary + fallbacks
  - Applied enforceModelPool() on all resolved chains
  - Sticky model validation against ALLOWED_MODEL_POOL

#### Context
- lib/transformers/request.ts � Changed compaction model from gemma-4-31b-it to gemma-4-26b-a4b-it

#### Tests Fixed (22 node:test import removals)
- 	ests/ai-compactor.test.ts
- 	ests/auth-redis.test.ts
- 	ests/context-compaction.test.ts
- 	ests/contradiction-detector.test.ts
- 	ests/dashboard-api-keys.test.ts
- 	ests/dashboard-auth-keys.test.ts
- 	ests/dashboard-metrics.test.ts
- 	ests/dashboard-routing.test.ts
- 	ests/dependency-compatibility.test.ts
- 	ests/interactive-command-guard.test.ts
- 	ests/metrics-redis.test.ts
- 	ests/model-adaptive.test.ts
- 	ests/model-router-redis.test.ts
- 	ests/operational-context.test.ts (also: opstate:v2 -> opstate:v3)
- 	ests/process-supervisor.test.ts
- 	ests/routing-cache.test.ts
- 	ests/routing-registry.test.ts
- 	ests/task-router.test.ts (also: updated COMPACTION + LIGHT_CODING chain expectations)
- 	ests/tool-structure.test.ts
- 	ests/web-recovery.test.ts
- 	ests/web-search.test.ts
- 	ests/redis-client.test.ts (also: ../lib/redis/client.js -> ../lib/redis/client)
- 	ests/redis-vector-store.test.ts (also: ./embedding-engine -> @/lib/memory/embedding-engine)

---

## Session: 8-Phase Focused Improvement Pass

### Phase 1 — Behavioral Routing

**New Files:**
- `tests/behavior-routing.test.ts` — 44 behavioral routing tests

**Modified Files:**
- `lib/routing/task-router.ts` — Full behavioral rewrite: added `BehavioralSignals`, `extractBehavioralSignals()`, `classifyFromBehavior()`, `WEB_SEARCH` task type, `WEB_SEARCH_CHAIN`; REASONING now requires formal proof patterns only; fixed trailing `\b` regex bug
- `tests/task-router.test.ts` — Updated for behavioral routing

### Phase 2 — Dynamic Key Racing

**Modified Files:**
- `lib/racing/key-racer.ts` — Added `getDynamicKeyCount(taskType, isOverload)`

**New Files:**
- `tests/dynamic-key-racing.test.ts` — Key racing tests for all task types

### Phase 3 — Dynamic Model Racing

**Modified Files:**
- `lib/racing/model-racer.ts` — Added `getDynamicModelRaceConfig()`, `getModelsForRace()`, `ModelRaceConfig` interface

**New Files:**
- `tests/dynamic-model-racing.test.ts` — Model racing + allowed pool compliance tests

### Phase 4 — Embedding Lifecycle Hardening

**Modified Files:**
- `lib/memory/redis-vector-store.ts` — Added `purgeStaleEntries()`, `applyIncrementalDiff()`, `checkFreshness()`
- `lib/memory/file-ingestion.ts` — Added `LOCK_FILE_PATTERNS` + lock file exclusion in `isEligibleExtension()`

**New Files:**
- `tests/embedding-lifecycle.test.ts` — FileHashStore diff, file filters, content hashing tests

### Phase 5 — Web Search Hard Timeout

**Modified Files:**
- `lib/tools/web-search.ts` — Added `executeWebSearchSafe()` with global 8s Promise.race timeout
- `lib/tools/search-executor.ts` — Updated import + call site: `executeWebSearch` → `executeWebSearchSafe`

**New Files:**
- `tests/web-search-timeout.test.ts` — Timeout safety + utility function tests

### Phase 6 — Telemetry Isolation

**Modified Files:**
- `app/api/v1/messages/route.ts` — 6 telemetry call sites converted to fire-and-forget (non-blocking):
  - `await incrementErrorCount` → `.catch(()=>{})` (streaming catch + outer catch)
  - `await recordLatency` → `.catch(()=>{})` (non-streaming + streaming finally)
  - `await recordTokens` → `.catch(()=>{})` (non-streaming + streaming finally)

### Phase 7 — Token Overhead Reduction (−67% worst case)

**Modified Files:**
- `lib/transformers/loop-detector.ts` — Compressed guidance: 5-step → 3-bullet (−61% tokens)
- `lib/transformers/adaptive-guidance.ts` — Compressed strong/light reminders (−64%)
- `lib/agent/completion-gate.ts` — Compressed completion gate guidance (−63%)
- `lib/agent/path-guard.ts` — Compressed path guard guidance (−69%)
- `lib/agent/interactive-command-guard.ts` — Compressed interactive command guidance (−60%)
- `lib/agent/spec-validator.ts` — Compressed spec validator guidance (−61%)
- `lib/agent/orchestrator-enforcer.ts` — Compressed orchestrator injection: XML block → single line (−82%)
- `lib/context/operational-state.ts` — Compressed state block header (−50%)

**Test Updates (for changed prefix strings):**
- `tests/interactive-command-guard.test.ts` — Updated string check
- `tests/model-adaptive.test.ts` — Updated regex
- `tests/orchestrator-enforcer.test.ts` — Updated string check (×2)

### Phase 8 — Performance Validation

**New Files:**
- `docs/BEHAVIOR_ROUTING_REPORT.md`
- `docs/DYNAMIC_RACING_REPORT.md`
- `docs/EMBEDDING_LIFECYCLE_REPORT.md`
- `docs/WEB_SEARCH_TIMEOUT_REPORT.md`
- `docs/TELEMETRY_ISOLATION_REPORT.md`
- `docs/TOKEN_OVERHEAD_REPORT.md`
- `docs/PERFORMANCE_VALIDATION_REPORT.md`

---

## Session: Overload-Aware Emergency Compaction

### New Files

- `lib/context/emergency-compactor.ts` — emergency overload compaction engine; rewrites active Gemini payload, persists canonical compacted state, reapplies it on later requests
- `tests/emergency-compaction.test.ts` — overload compaction coverage: immediate rewrite, future canonical rewrite, second compaction, third hard fallback, continuity preservation
- `docs/EMERGENCY_COMPACTION_REPORT.md` — feature report and validated success criteria

### Modified Files

- `lib/retry-engine.ts` — overload branches now detect `529` / `overloaded_error` / `capacity_error`, trigger emergency compaction immediately, invalidate stale cache state, and log `OVERLOAD_DETECTED` + `FALLBACK_MODEL_SELECTED`
- `lib/transformers/request.ts` — loads persisted emergency compaction state and replaces expanded raw history with canonical compacted context before normal hydration/compaction
- `lib/transformers/stream.ts` — threads emergency compaction request context into streaming retry execution
- `app/api/v1/messages/route.ts` — threads emergency compaction request context into non-streaming retry execution
- `lib/recovery/overload-recovery.ts` — overload classifier now recognizes `529` + `capacity_error`; fallback chain updated to `gemini-2.5-flash → gemini-3-flash-preview → gemini-3.1-flash-lite-preview → gemini-flash-latest`
- `tests/overload-recovery.test.ts` — added `529` / `capacity_error` assertions and updated exhausted fallback chain expectation
- `tests/fallback-overload.test.ts` — updated final fallback expectation to `gemini-flash-latest`
- `docs/OVERLOAD_RECOVERY_REPORT.md` — refreshed for emergency compaction architecture and new fallback chain
- `docs/TEST_RESULTS.md` — updated to final validated counts: `75/75` suites, `811/811` tests
