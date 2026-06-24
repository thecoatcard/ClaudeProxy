# Operational Context Report

## Overview

The gateway now maintains persistent **operational context memory** per
conversation in Redis. This solves the core problem of the model forgetting
operational facts between turns: which shell is being used, which files were
created or are missing, which approaches have repeatedly failed, and which
background processes are running.

A compact guidance block derived from this state is injected into every
`systemInstruction` so the model receives operational context without requiring
it to re-infer environment details from scratch each turn.

---

## Schema

`OperationalState` (version 2) is stored as JSON under the key
`opstate:v2:{conversationId}` with a **6-hour TTL**.

```typescript
interface OperationalState {
  version: 2;
  conversationId: string;
  shell_type: ShellType;          // 'bash'|'git-bash'|'powershell'|'cmd'|'wsl'|'sh'|'zsh'|'fish'|'unknown'
  environment_type: EnvironmentType; // 'windows'|'unix'|'wsl'|'unknown'
  shell_capability: ShellCapability;
  interactive_supported: boolean;
  known_project_root: string | null;
  known_artifacts: Record<string, ArtifactRecord>;
  active_background_tasks: BackgroundTask[];
  blocked_patterns: string[];     // patterns never to retry
  known_failures: FailureRecord[];
  successful_patterns: string[];
  tool_chain_state: ToolChainEntry[];
  updatedAt: string;
}
```

### ShellCapability

```typescript
interface ShellCapability {
  tty_supported: boolean;
  windows_native_commands_supported: boolean;
  unix_process_control_supported: boolean;
  interactive_stdin_supported: boolean;
}
```

### ArtifactRecord

```typescript
interface ArtifactRecord {
  path: string;
  status: 'exists' | 'missing' | 'failed_create' | 'modified';
  lastSeen: string;  // ISO timestamp
  source: string;    // tool name that last reported this state
}
```

### FailureRecord

```typescript
interface FailureRecord {
  pattern: string;     // slug, e.g. 'tty_not_available'
  description: string; // human-readable
  count: number;       // occurrences
  lastSeen: string;
}
```

---

## Shell Detection Rules

Shell type is inferred from tool_use inputs and tool_result output text.

| Signal | Detected Shell | Environment |
|--------|---------------|-------------|
| `powershell` or `pwsh` in command | `powershell` | windows |
| `git-bash`, `mingw`, `msys` in command | `git-bash` | windows |
| `cmd` or `command.com` in command | `cmd` | windows |
| `wsl` in command | `wsl` | wsl |
| `/bin/zsh` or `zsh` | `zsh` | unix |
| `/bin/fish` or `fish` | `fish` | unix |
| `/bin/bash` or `bash` | `bash` | unix |
| `/bin/sh` | `sh` | unix |
| Windows path `C:\...` in output | `cmd` | windows |
| `kill -9`, `pkill`, `killall` in output | `bash` | unix |

Shell type is **only updated when currently `'unknown'`** — once detected it
is treated as stable for the lifetime of the conversation.

---

## Artifact Tracking

### What gets tracked

| Source | Status set |
|--------|-----------|
| `write_file` / `create_file` / `str_replace` tool with explicit `path` input — success | `exists` |
| Write tool with explicit `path` — error result | `failed_create` |
| `No such file` / `cannot find` / `file not found` in error output | `missing` |
| File name in `created` / `wrote` in result text | `exists` |

### Limits

Up to **100 artifacts** are retained (oldest by `lastSeen` are evicted).

---

## Background Task Detection

Seven process patterns are monitored:

| Pattern regex | Process slug | Startup signals |
|---------------|-------------|----------------|
| `npm run dev/start/serve/watch` | `npm` | ready, listening, started, compiled |
| `yarn dev/start` | `yarn` | ready, listening, started |
| `uvicorn` | `uvicorn` | Application startup complete, Uvicorn running on |
| `cargo run` | `cargo` | Finished, Running |
| `dotnet run` | `dotnet` | Now listening on, Application started |
| `docker-compose up` | `docker-compose` | healthy, done, started |
| `next dev/start` | `next` | Ready, started server |

### Task lifecycle

```
command detected in tool_use input → status: 'unknown'
  └── tool_result is_error: true  → status: 'failed'   ← checked FIRST (avoids false positives)
  └── startup signal in result   → status: 'running'
  └── no signal, no error        → status: 'unknown'
```

Error is checked **before** startup signals to avoid false positives (e.g.
`"address already in use"` contains the substring `"ready"`).

Up to **10 tasks** are retained.

---

## Failure Pattern Recording

Six failure slugs are detected from tool names + input/output text:

| Slug | Trigger |
|------|---------|
| `interactive_cli_wizard` | `shadcn init`, `prisma init`, `create-next-app`, `firebase init`, etc. |
| `tty_not_available` | `/dev/tty`, `tty not available`, `inappropriate ioctl` |
| `permission_denied` | `Permission denied`, `EACCES` |
| `command_not_found` | `command not found`, `not recognized as an internal/external command` |
| `network_unreachable` | `ENOTFOUND`, `fetch failed`, `ECONNREFUSED` |
| `windows_unix_mismatch` | Unix commands (`kill -9`) on Windows or vice versa |

### Escalation to `blocked_patterns`

After **2 occurrences**, a failure slug is automatically added to
`blocked_patterns`. The guidance block then includes an explicit
`BLOCKED patterns (do NOT retry)` line.

Up to **20 failure records** are retained.

---

## Guidance Block Format

`buildOperationalGuidance` returns an empty string when all state fields are
`'unknown'` with no artifacts or background tasks — no noise for fresh
conversations.

When state is non-trivial, the following block is appended to
`systemInstruction`:

```
---
[GATEWAY OPERATIONAL CONTEXT]
Shell: powershell | Environment: windows
  Capabilities: no TTY, no interactive stdin, Windows commands available
Project root: /workspace/myapp
Known existing files/dirs: src/app.ts, package.json, tsconfig.json
Known missing files/dirs: src/config.ts
Background processes running: npm
  Do NOT attempt to restart or terminate these unless explicitly requested.
BLOCKED patterns (do NOT retry): interactive_cli_wizard, tty_not_available
Repeated failures (find a different approach):
  - Interactive CLI wizard blocked (requires TTY input) (3× failed)
  - TTY not available (/dev/tty or similar failed) (2× failed)
WARNING: Windows environment — do NOT use /dev/null, kill -9, pkill, or Unix-only paths.
WARNING: Interactive stdin not supported. Always use non-interactive flags for CLI tools.
---
```

### Shell-specific warnings

| Condition | Warning added |
|-----------|--------------|
| Windows (non-WSL) | No `/dev/null`, `kill -9`, `pkill`, or Unix paths |
| Git Bash | Mixed Win/Unix — use `kill {pid}` or `taskkill /F /PID {pid}` |
| No interactive stdin | Always use non-interactive CLI flags |

---

## Redis Key Structure

| Key | TTL | Contents |
|-----|-----|---------|
| `opstate:v2:{conversationId}` | 6 hours | JSON-serialized `OperationalState` |

`{conversationId}` is the same ID derived by `deriveConversationId()` in
`request.ts` (hash of model + first user message content).

### Validation on load

Loaded JSON must pass:
1. `parsed.version === 2`
2. `parsed.conversationId === conversationId`

On any failure (Redis miss, parse error, version mismatch, ID mismatch),
`defaultOperationalState()` is returned — never throws.

---

## Integration Point

Wired into `lib/transformers/request.ts` inside `transformRequestToGemini`:

```
1. conversationId derived
2. loadOperationalState(conversationId)  ← async, runs in main path
3. updateStateFromMessages(state, messages)  ← pure function, no I/O
4. buildOperationalGuidance(updatedState)  ← if non-empty, appended to systemText
5. saveOperationalState(updatedState)  ← fire-and-forget, never blocks request
```

The Redis store adapter wraps `redis.get<string>()` and `redis.set()` from
`lib/redis.ts` (existing Upstash REST client).

---

## Files

| File | Change |
|------|--------|
| `lib/context/operational-state.ts` | **NEW** — full operational state system |
| `lib/transformers/request.ts` | Modified — imports + load/update/inject/save wiring |
| `tests/operational-context.test.ts` | **NEW** — 20 tests covering all subsystems |
