# Operational Context V2 Report

## Summary

Extended the AI gateway's operational context tracking system from v2 to v3, adding structured support for workspace discovery, dependency version tracking, resolved path patterns, and subagent task coordination.

## Changes

### `lib/context/operational-state.ts` — Upgraded to v3

**New types:**

| Type | Purpose |
|------|---------|
| `SubagentTask` | Track parallel subagent work (id, status, owner, filesTouched, dependencies) |
| `DependencyRecord` | Track detected package versions with source attribution |

**New fields in `OperationalState`:**

| Field | Purpose |
|-------|---------|
| `workspace_root` | Absolute workspace root detected from tool output |
| `current_working_root` | Active CWD from last `cd` signal |
| `known_directories` | Confirmed directories from ls/list tool results |
| `dependency_versions` | Detected package versions by name |
| `resolved_patterns` | Complement to blocked_patterns — known-good paths |
| `active_subagent_tasks` | Parallel subagent task tracking |

**New functions:**

- `detectCwdFromText(text)` — Detects CWD from tool outputs (exported)
- `extractDependencyVersions(toolName, toolInput, resultText, isError)` — Parses npm install outputs, package.json reads, import errors

**`updateStateFromMessages()` enhancements:**
- Detects workspace_root + CWD from tool result text
- Tracks known_directories from directory listings
- Extracts dependency versions from install outputs

**Redis key:** `opstate:v3:{conversationId}` (old v2 keys naturally expire — no migration needed)

### `lib/agent/artifact-verifier.ts` — Created

Verifies artifact existence using OperationalState evidence before write/build operations.

- Types: `ArtifactConfidence = 'verified' | 'uncertain' | 'likely_missing' | 'unknown'`
- Functions: `verifyArtifact()`, `buildVerificationGuidance()`, `extractPathsForVerification()`
- Stale threshold: 30 minutes

### `lib/agent/background-task-tracker.ts` — Created

Enforces ordering — background tasks must complete before dependent operations.

- Covers: npm install, pip install, cargo, docker build, create-next-app, create-react-app
- Functions: `checkTaskBlockers()`, `buildDependencyGuidance()`, `registerBackgroundTask()`

## Test Coverage

Covered by the `dependency-compatibility.test.ts` and `contradiction-detector.test.ts` test suites.
