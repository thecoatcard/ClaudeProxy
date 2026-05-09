# FILES_CHANGED.md

---

## Session: Web Search + Operational Context (current)

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
