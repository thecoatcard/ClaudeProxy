# Agent Runtime Plan

## Decision

Keep `/api/v1/messages` as the stateless Anthropic-compatible gateway. Build the agent runtime as a separate Node.js control plane and worker system. Do not enable the legacy `lib/agent/orchestrator-enforcer.ts` path in production: it is not connected to the messages route, does not execute tools, and cannot resume work durably.

## Architecture

1. Runtime API authenticates owners and creates, reads, cancels, and streams runs.
2. MongoDB is the durable store for runs, tasks, attempts, messages, artifacts, and events.
3. Redis is coordination only: ready queues, leases, heartbeats, retry timers, locks, and transient fanout.
4. Planner converts a user objective into a validated task DAG.
5. Scheduler promotes dependency-satisfied tasks to a ready queue and enforces global, tenant, and run concurrency limits.
6. Workers atomically lease tasks, execute model/tool loops, heartbeat leases, and persist every step.
7. Mailbox provides durable, typed inter-agent messages. Agents exchange artifact references rather than copying large outputs into prompts.
8. Tool runner validates schemas and capabilities, applies workspace/security policy, executes with deadlines and cancellation, and records auditable results.
9. Event stream drives SSE status updates, metrics, audit history, and runtime recovery.

Reuse `lib/redis/client.ts`, `lib/gemini-adapter.ts`, `lib/key-manager.ts`, `lib/retry-engine.ts`, `lib/logging/event-logger.ts`, and `lib/transformers/tools.ts`. Add runtime modules under `lib/runtime/agent/`, API routes under `app/api/runtime/runs/`, and a separately deployable worker entry point.

## Domain Model and State Machines

Every record includes `id`, `runId`, `ownerId`, `version`, `createdAt`, and `updatedAt` where applicable.

### Run

`QUEUED -> RUNNING -> COMPLETED | FAILED`

Cancellation uses `QUEUED | RUNNING -> CANCEL_REQUESTED -> CANCELLED`. A run may also be `WAITING` while all unfinished tasks await dependencies, approval, or retry time. Terminal states are `COMPLETED`, `FAILED`, and `CANCELLED`; no transition may leave a terminal state.

### Task

`BLOCKED -> READY -> LEASED -> RUNNING -> SUCCEEDED | FAILED`

Additional transitions:

- `RUNNING -> WAITING_TOOL -> RUNNING`
- `RUNNING -> READY` for a scheduled retry after the retry delay expires
- any non-terminal state to `CANCELLED`
- `BLOCKED -> SKIPPED` when a required dependency fails permanently
- `LEASED | RUNNING | WAITING_TOOL -> READY` after an expired lease, subject to attempt limits

Terminal task states are `SUCCEEDED`, `FAILED`, `SKIPPED`, and `CANCELLED`.

### Attempt

`STARTED -> SUCCEEDED | FAILED | CANCELLED | TIMED_OUT | LEASE_EXPIRED`.

Attempts are immutable after becoming terminal. A fencing token prevents an expired worker from committing a late result.

## Inter-Agent Communication Protocol

Messages are immutable envelopes:

```ts
interface AgentMessage {
  id: string;
  runId: string;
  fromTaskId: string;
  to: { taskId?: string; role?: string; topic?: string };
  kind: 'REQUEST' | 'RESPONSE' | 'PROGRESS' | 'ARTIFACT' | 'CONTROL';
  correlationId?: string;
  causationId?: string;
  sequence: number;
  payloadRef: string; // content-addressed artifact, not unbounded inline data
  createdAt: number;
}
```

Publishing must persist the message before delivery. Consumers acknowledge only after incorporating it into durable task state. Message IDs provide deduplication; `(sender, recipient, sequence)` provides ordering detection. Correlation and causation IDs support request/reply and tracing. Authorization requires the same run and owner unless an explicit cross-run capability exists.

Redis Streams consumer groups provide delivery and recovery. Communication is at-least-once, so handlers must be idempotent. Agents must not communicate through process-local maps or console output.

## Storage and Atomicity

MongoDB collections:

| Collection | Purpose |
| --- | --- |
| `agent_runs` | Run state, owner, version, cancellation flag, counters |
| `agent_tasks` | Task definition, state, dependency counters, lease data |
| `agent_attempts` | Immutable attempt history and fencing token |
| `agent_messages` | Durable inter-agent mailbox and correlation metadata |
| `agent_artifacts` | Content-addressed payload metadata and external blob pointers |
| `agent_events` | Append-only lifecycle, audit, and recovery events |

Redis coordination keys:

| Key | Type | Purpose |
| --- | --- | --- |
| `ar:v1:ready` | Stream | Ready-task work queue |
| `ar:v1:retry` | Sorted set | Tasks ordered by next retry timestamp |
| `ar:v1:lease:{taskId}` | Hash | Current lease holder and expiry |
| `ar:v1:owner:{ownerId}:runs` | Sorted set | Cached owner-scoped run listing |
| `ar:v1:mailbox:{runId}` | Stream | Transient fanout and worker wakeups |

Lua scripts or Redis transactions must implement:

- compare-and-set state transitions using `version`
- atomic task lease acquisition with worker ID, lease expiry, and monotonically increasing fencing token
- heartbeat renewal only by the current lease holder
- result commit only when lease and fencing token still match
- dependency decrement and exactly-once promotion from `BLOCKED` to `READY`
- cancellation flag update plus cancellation event append
- message deduplication plus stream append
- queue wakeup and lease refresh hints for the worker pool

MongoDB is required for durable runtime readiness. Redis failure should degrade coordination, not erase run history. Dependency failure must return `503`, not `401` or empty data. Mutations fail closed. Health endpoints distinguish liveness from MongoDB/Redis/auth/provider readiness.

## Tool Execution and Security

Tools are registered with input/output schemas, capability names, idempotency behavior, timeout limits, and an adapter. Before execution, the policy layer verifies owner, run, workspace root, allowed capability, approval requirements, path scope, URL/SSRF rules, and payload limits.

Every model request and tool process receives an `AbortSignal`. Tool execution has wall-clock and output limits. Non-idempotent tools require an idempotency key or reconciliation step before retry. Secrets are encrypted or referenced, never included in prompts, artifacts, or events. Logs redact credentials and sensitive tool arguments.

## Retry, Cancellation, and Recovery

Classify errors as transient, permanent, policy, cancellation, or unknown. Retry only transient failures with bounded exponential backoff, jitter, `Retry-After` support, and per-task/per-run attempt budgets. Persist model, key, tool, and error history for each attempt.

Cancellation sets the durable run flag, publishes a control event, stops scheduling, and propagates to active model calls and tools. Workers poll or subscribe for cancellation while heartbeating. A run becomes `CANCELLED` only after active attempts acknowledge cancellation or their leases expire.

On worker crash, expired leases are reclaimed with a new fencing token. Resume loads persisted task outputs and messages; it never reconstructs dependencies from process memory or reruns successful tasks.

## Observability

Emit structured events containing `runId`, `taskId`, `attemptId`, `workerId`, `messageId`, model/tool name, duration, token/cost data, retry classification, and redacted error details. Track queue depth, scheduling delay, lease expirations, retries, cancellation latency, model/tool latency, token usage, and terminal outcomes. SSE clients resume from an event cursor.

## Implementation Phases

### Phase 0: Contracts and containment

- Document the runtime/gateway boundary and keep the legacy orchestrator disabled.
- Define schemas, transition tables, error taxonomy, and capability policy.
- Add runtime-specific configuration validation and an ADR.

**Acceptance:** no runtime code is invoked by `/api/v1/messages`; all contracts have unit-testable schemas; invalid transitions are enumerated.

### Phase 1: Durable state and read APIs

- Implement repository interfaces, MongoDB collections/indexes, atomic transition scripts, artifact storage, and append-only events.
- Add create/get/list run APIs and SSE event reads.

**Acceptance:** concurrent transition tests admit one winner; run listing uses indexes, not `SCAN`; Mongo or Redis outages return typed `503` as appropriate; SSE reconnects without losing events.

### Phase 2: Scheduler and worker lifecycle

- Implement DAG validation, ready promotion, leases, heartbeats, fencing, quotas, delayed retries, crash recovery, and cancellation.

**Acceptance:** two workers cannot commit the same lease; cyclic/missing dependencies are rejected; crashed work resumes; cancellation reaches terminal state within a defined bound.

### Phase 3: Persisted model execution

- Execute bounded model steps through existing provider routing and persist prompts, outputs, usage, and attempt history.
- Replace generic stub descriptions with planner-generated tasks containing the actual scoped objective and context references.

**Acceptance:** a worker restart preserves successful outputs; dependent tasks receive persisted results; model fallback history is visible; completed tasks are never rerun during resume.

### Phase 4: Sandboxed tool loop

- Add capability registry, policy engine, approvals, schema validation, idempotency, timeouts, output bounds, and cancellation propagation.

**Acceptance:** unauthorized tools and out-of-root paths are rejected; cancellation terminates active tools; retry behavior is safe for non-idempotent operations; every tool action is auditable.

### Phase 5: Mailboxes and dynamic DAGs

- Add typed agent messaging, correlation, deduplication, artifact references, and controlled task creation.

**Acceptance:** messages survive restarts, duplicate delivery has no duplicate effect, ordering gaps are detected, and cross-owner communication is denied.

### Phase 6: Operations and rollout

- Replace the current orchestrator admin data source with indexed runtime repositories backed by MongoDB.
- Add pause/drain/cancel controls, dashboards, alerts, retention, and staged feature flags.

**Acceptance:** control-plane auth distinguishes unauthenticated `401` from dependency-unavailable `503`; operators can drain workers without losing work; rollback leaves persisted runs recoverable.

## Required Test Matrix

- State-machine transition table, terminal-state immutability, optimistic-lock races, and fencing-token rejection.
- DAG cycle, missing dependency, failed dependency, parallel readiness, and quota fairness.
- Multi-worker lease contention, heartbeat, lease expiry, crash recovery, and duplicate stream delivery.
- Resume with persisted dependency outputs and no re-execution of successful tasks.
- Cancellation while queued, in model generation, in tool execution, and waiting for retry/approval.
- Retry classification, backoff bounds, attempt exhaustion, `Retry-After`, and non-idempotent reconciliation.
- Mailbox ordering, deduplication, correlation, authorization, payload limits, and restart recovery.
- Tool schema, approval, workspace traversal, command injection, SSRF, secret redaction, timeout, and output-limit tests.
- Redis outage and recovery, readiness semantics, auth `401` versus dependency `503`, and indexed list behavior.
- SSE cursor reconnect, event ordering, metrics dimensions, and audit completeness.
- End-to-end: plan a DAG, run parallel agents, exchange artifacts/messages, execute an approved tool, restart a worker, merge results, and reach one terminal run outcome.

## Integration Files

- Add: `lib/runtime/agent/{types,repository,state-machine,scheduler,worker,mailbox,artifacts,tool-runner,policy}.ts`
- Add: `app/api/runtime/runs/route.ts`
- Add: `app/api/runtime/runs/[id]/route.ts`
- Add: `app/api/runtime/runs/[id]/cancel/route.ts`
- Add: `app/api/runtime/runs/[id]/events/route.ts`
- Add: a dedicated worker entry point and deployment command
- Adapt: `app/api/admin/orchestrator/route.ts` and `app/dashboard/orchestrator/page.tsx`
- Reuse: Redis, provider/key routing, retry, structured logging, and tool-schema transformation modules listed above
- Do not integrate with `app/api/v1/messages/route.ts` until an explicit asynchronous runtime protocol is designed and versioned
