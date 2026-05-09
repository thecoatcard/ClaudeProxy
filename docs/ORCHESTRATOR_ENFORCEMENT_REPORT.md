# ORCHESTRATOR ENFORCEMENT REPORT

## Summary

Orchestrator-first execution is now enforced for all non-trivial Claude Code tasks
passing through the gateway.

---

## Architecture

```
Claude Code
  → POST /api/v1/messages
  → prepareOrchestration()          ← lib/agent/orchestrator-enforcer.ts
  → [injects coordinator prompt]
  → getModelMapping()               ← lib/model-router.ts
  → executeWithRetry() / transformStream()
  → Gemini/Gemma
  → finalizeOrchestration()
  → Claude Code
```

---

## Components Created

### lib/agent/task-complexity.ts
Classifies every incoming request into one of four complexity levels:

| Level | Description | Orchestrator |
|-------|-------------|--------------|
| TRIVIAL | Single step, no tools, no system changes | Not required |
| NORMAL | Small coding task, single file | Required |
| COMPLEX | Multiple files / tools / systems | Required |
| MULTI_STAGE | Full app builds, refactors, architecture | Required |

**Explicit override commands** (always force orchestrator mode):
- `switch to orchestrator`
- `use subagents`
- `parallelize`
- `delegate`

**Auto-trigger keywords** (MULTI_STAGE):
- `build`, `create app`, `from scratch`, `full stack`, `dashboard`,
  `auth`, `database`, `api`, `refactor`, `architecture`, `migration`

### lib/agent/orchestrator-enforcer.ts
Gateway enforcement layer that:

1. Calls `classifyComplexity()` on every incoming request
2. For NORMAL/COMPLEX/MULTI_STAGE: injects `<orchestrator_mode>` hidden system prompt
3. Creates coordinator plan + subagent task stubs in Redis
4. After model call: calls `finalizeOrchestration()` to mark tasks complete

**Subagent model assignments:**

| Role | Model |
|------|-------|
| Reasoning / Planning | `gemma-4-31b-it` |
| Coding subagents | `gemini-2.5-flash` |
| Fast checks / Verification | `gemini-2.5-flash-lite` |
| Compaction | `gemma-4-26b-a4b-it` |

### lib/agent/subagent-memory.ts
Redis-backed subagent task store. Fields tracked per task:

- `id`, `parentId`, `owner`
- `description`, `model`
- `dependencies[]` — tasks that must complete first
- `status` — PENDING → RUNNING → COMPLETED / FAILED
- `artifacts[]` — output file paths / hashes
- `createdAt`, `updatedAt`, `completedAt`

TTL: 24 hours (survives context compaction windows).

---

## Gateway Integration (app/api/v1/messages/route.ts)

Changes:
- Imported `prepareOrchestration`, `finalizeOrchestration`
- After body parse: call `prepareOrchestration(body, token)`
- `activeBody` (enriched with coordinator prompt) used for all model calls
- After streaming/non-streaming response: call `finalizeOrchestration(orchCtx)`
- Errors in orchestration layer are **non-fatal** (graceful catch fallback)

---

## Orchestrator Prompt Injection

The following hidden instruction is appended to every non-trivial system prompt:

```
<orchestrator_mode>
You are operating as the coordinator for this task.

Before taking any direct action you MUST:
1. Decompose the task into discrete sub-tasks.
2. Assign each sub-task to the most appropriate subagent model.
3. Execute sub-tasks in dependency order (parallelise where safe).
4. Verify the output of each completed sub-task before proceeding.
5. Merge all sub-task results into a coherent final answer.

Never continue in single linear mode for multi-step or multi-file work.
</orchestrator_mode>
```

---

## Orchestrator Logging

Log events emitted to console.info with prefix `[orchestrator]`:

| Event | Triggered when |
|-------|---------------|
| `orchestrator-status` | Every request — reports complexity level |
| `task-decomposition` | Subagent stubs created |
| `subagents-assigned` | Tasks persisted to Redis |
| `subagent-completed` | Individual task finalized |
| `merge-completed` | All tasks finalized |

---

## Success Criteria

- [x] Build fixed (was already passing; no regressions introduced)
- [x] Orchestrator auto-enables for NORMAL/COMPLEX/MULTI_STAGE tasks
- [x] TRIVIAL tasks bypass orchestrator (no overhead)
- [x] Explicit override commands force orchestrator mode
- [x] Subagent decomposition creates planner + coder + verifier stubs
- [x] Subagent tasks persisted in Redis with 24h TTL
- [x] Gateway uses enriched body (coordinator prompt) for all model calls
- [x] Logs show orchestrator behavior at every stage
- [x] Task-aware routing uses correct model per role
