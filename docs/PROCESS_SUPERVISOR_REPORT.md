# PROCESS_SUPERVISOR_REPORT.md

## Objective
Implement a generic long-running process supervisor in the behavior layer that detects dev/server process intent across ecosystems, analyzes startup output semantics, and injects non-blocking operational guidance.

## Implemented

### 1) Command detector (multi-ecosystem)
Added `lib/agent/process-supervisor.ts` with `detectLongRunningProcessCommand()`.

Coverage includes:
- JavaScript: npm run dev, pnpm dev, yarn dev, next dev, vite, nodemon, webpack serve
- Python: flask run, uvicorn, gunicorn, django runserver, streamlit run
- Go: go run, air
- Rust: cargo run, cargo watch
- Java: spring-boot:run, bootRun
- PHP: artisan serve, php -S
- Ruby: rails server
- C#: dotnet run
- Docker: docker compose up, docker run
- Generic: serve, live-server, http-server
- Package-manager script aliases (dev/start/serve/watch/preview)

Classification:
- `LONG_RUNNING_PROCESS`
- `NON_LONG_RUNNING`

### 2) Output analyzer
Added `analyzeLongRunningProcessOutput()` with startup state classification:
- `STARTED`
- `FAILED`
- `UNKNOWN`

Signal policy:
- Success signals: listening on, server started, ready on, compiled successfully, running at, local:, network:, ready in, started successfully, application startup complete
- Failure signals: syntax error, failed to compile, module not found, import error, panic, traceback, unhandled exception, failed to start
- Port fallback handling: port in use + using available/fallback port treated as recovery

Priority implemented exactly:
- Success signals
- then failure signals
- then exit code

Result:
- `exit code 1 + ready` is classified `STARTED`
- `port fallback + ready` is classified `STARTED`

### 3) Interval monitoring policy guidance
Added history assessment `assessLongRunningProcessHistory()` that injects behavior-layer guidance:
- Run long-running process in background
- Monitor logs every 30 seconds
- Continue workflow when startup success detected
- Diagnose/retry on startup failure
- Continue monitoring when unknown
- Prevent indefinite blocking interpretation

### 4) Environment-aware process control guidance
Added shell detection + termination guidance:
- Git Bash: prefer `cmd /c taskkill /F /PID <pid>`
- PowerShell/CMD: `taskkill /F /PID <pid>`
- Unix/WSL: `kill -9 <pid>` in same namespace

This is guidance-only; no runtime process-control changes were made.

### 5) Behavior auditor integration
Integrated into `runBehaviorAudit()` in `lib/agent/behavior-auditor.ts`:
- Assesses long-running command/history patterns
- Injects long-running process supervisor guidance
- Adds diagnostics fields:
  - `longRunningProcessDetected`
  - `longRunningProcessState`

## Constraints Compliance
- Edge-compatible: yes (pure text analysis, no node process APIs)
- Translator-only behavior: yes
- No tool runtime changes: yes

## Validation
Added tests in `tests/process-supervisor.test.ts`.

Requested scenarios covered:
1. npm run dev detected
2. uvicorn detected
3. cargo run detected
4. dotnet run detected
5. docker compose up detected
6. startup success detected
7. startup failure detected
8. build command ignored
9. lint command ignored
10. exit code 1 + ready = STARTED
11. port fallback + ready = STARTED
12. Git Bash environment kill guidance correct
13. PowerShell environment kill guidance correct
14. Unix environment kill guidance correct

All process-supervisor tests pass.
