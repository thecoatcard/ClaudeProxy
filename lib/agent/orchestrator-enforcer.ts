/**
 * lib/agent/orchestrator-enforcer.ts
 *
 * Legacy gateway orchestrator layer.
 *
 * The gateway is an Anthropic-compatible infrastructure layer, not an agent
 * runtime. This module is inert unless ENABLE_GATEWAY_ORCHESTRATOR=true.
 *
 * Architecture enforced here:
 *
 *   Claude Code
 *     → OrchestratorEnforcer.prepare()   ← this file
 *     → gateway (model call)
 *     → Gemini/Gemma
 *     → OrchestratorEnforcer.finalize()
 *     → Claude Code
 *
 * Default behaviour for NORMAL/COMPLEX/MULTI_STAGE complexity:
 *   1. Create coordinator plan internally
 *   2. Split into sub-tasks
 *   3. Assign subagent models
 *   4. Track sub-task work via subagent-memory
 *   5. Merge subagent results
 *   6. Verify final output
 */

import { classifyComplexity, isGatewayOrchestratorEnabled, type ComplexityResult } from './task-complexity';
import { shouldSkipOrchestrator } from './intent-detector';
import {
  createSubagentTask,
  saveSubagentTask,
  getSubagentTasksByParent,
  updateSubagentStatus,
  type SubagentTask,
} from './subagent-memory';
import { scheduleSubagentTasks } from './subagent-scheduler';
import { mergeSubagentOutputs } from './subagent-merge';
import {
  createOrchestrationRecord,
  transitionOrchestrationState,
  finalizeMerge,
  checkAndIncrementLoopCount,
  isTerminalState,
} from './orchestrator-state';
import {
  buildRequestFingerprint,
  checkOrchestrationDedup,
  registerOrchestrationFingerprint,
} from './orchestrator-lock';
import { recordSubagentPerformance, type SubagentRole } from './subagent-performance';

// ---------------------------------------------------------------------------
// Model assignments per role
// ---------------------------------------------------------------------------

const MODEL_ASSIGNMENTS = {
  /** Deep reasoning and planning. */
  REASONING: 'gemma-4-31b-it',
  /** Code generation sub-tasks. */
  CODING: 'gemini-2.5-flash',
  /** Fast validation / checks. */
  FAST_CHECK: 'gemini-2.5-flash-lite',
  /** Context compaction. */
  COMPACTION: 'gemma-4-26b-a4b-it',
} as const;

// ---------------------------------------------------------------------------
// Orchestrator system-prompt injection
// ---------------------------------------------------------------------------

/**
 * The hidden coordinator instruction injected into every non-trivial system
 * prompt.  This shapes the model's behaviour without exposing implementation
 * details to the end user.
 */
const ORCHESTRATOR_SYSTEM_INJECTION = `

<orchestrator_mode>
You are operating as the **coordinator** for this task.

Before taking any direct action you MUST:
1. Decompose the task into discrete sub-tasks.
2. Assign each sub-task to the most appropriate subagent model.
3. Execute sub-tasks in dependency order (parallelise where safe).
4. Verify the output of each completed sub-task before proceeding.
5. Merge all sub-task results into a coherent final answer.

Never continue in single linear mode for multi-step or multi-file work.
Always prefer parallelism over sequential execution when there are no
data dependencies between steps.
</orchestrator_mode>
`.trim();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorContext {
  parentId: string;
  complexity: ComplexityResult;
  subagentTasks: SubagentTask[];
  orchestratorEnabled: boolean;
  systemPromptInjected: boolean;
}

// ---------------------------------------------------------------------------
// Main enforcer
// ---------------------------------------------------------------------------

/**
 * Prepare a request body for orchestrated execution.
 *
 * - Classifies complexity.
 * - If orchestrator is required, injects the coordinator system prompt and
 *   creates the initial set of subagent task records in Redis.
 * - Returns an OrchestratorContext that callers use in finalize().
 */
export async function prepareOrchestration(
  requestBody: Record<string, unknown>,
  userId: string
): Promise<{
  enrichedBody: Record<string, unknown>;
  ctx: OrchestratorContext;
}> {
  const complexity = classifyComplexity(requestBody);

  if (!isGatewayOrchestratorEnabled()) {
    const ctx: OrchestratorContext = {
      parentId: '',
      complexity: { ...complexity, orchestratorRequired: false },
      subagentTasks: [],
      orchestratorEnabled: false,
      systemPromptInjected: false,
    };
    return { enrichedBody: requestBody, ctx };
  }

  // ── Guard: skip orchestrator for trivial chat / questions ──────────────
  const skipOrchestrator = shouldSkipOrchestrator(requestBody);
  if (skipOrchestrator && !complexity.explicitOverride) {
    logOrchestrator('orchestrator-status', {
      complexityLevel: complexity.level,
      orchestratorRequired: false,
      reason: `intent-guard: ${complexity.reason}`,
      skipped: true,
      userId,
    });
    const ctx: OrchestratorContext = {
      parentId: '',
      complexity: { ...complexity, orchestratorRequired: false },
      subagentTasks: [],
      orchestratorEnabled: false,
      systemPromptInjected: false,
    };
    return { enrichedBody: requestBody, ctx };
  }

  logOrchestrator('orchestrator-status', {
    complexityLevel: complexity.level,
    orchestratorRequired: complexity.orchestratorRequired,
    reason: complexity.reason,
    explicitOverride: complexity.explicitOverride,
    userId,
  });

  if (!complexity.orchestratorRequired) {
    const ctx: OrchestratorContext = {
      parentId: '',
      complexity,
      subagentTasks: [],
      orchestratorEnabled: false,
      systemPromptInjected: false,
    };
    return { enrichedBody: requestBody, ctx };
  }

  // ── Phase 2: Deduplication check ──────────────────────────────────────────
  const fingerprint = buildRequestFingerprint(userId, requestBody);
  const dedupResult = await checkOrchestrationDedup(fingerprint);
  if (dedupResult.reuse) {
    logOrchestrator('orchestrator-status', { action: 'dedup-reuse', parentId: dedupResult.parentId });
    const ctx: OrchestratorContext = {
      parentId: dedupResult.parentId,
      complexity,
      subagentTasks: dedupResult.tasks,
      orchestratorEnabled: true,
      systemPromptInjected: true,
    };
    return { enrichedBody: injectOrchestratorPrompt(requestBody), ctx };
  }

  // ── Generate a parent task id ──────────────────────────────────────────────
  const parentId = `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── Phase 1: Create state record + Phase 8: Loop detection ────────────────
  await createOrchestrationRecord(parentId, userId);
  await transitionOrchestrationState(parentId, 'RUNNING');

  // ── Phase 2: Register fingerprint for dedup ────────────────────────────────
  await registerOrchestrationFingerprint(fingerprint, parentId);

  // ── Inject coordinator system prompt ──────────────────────────────────────
  const enrichedBody = injectOrchestratorPrompt(requestBody);

  // ── Create subagent task stubs ─────────────────────────────────────────────
  const subagentTasks = await createSubagentStubs(
    parentId,
    userId,
    complexity.level,
    requestBody
  );

  logOrchestrator('task-decomposition', {
    parentId,
    subTaskCount: subagentTasks.length,
    subTasks: subagentTasks.map((t) => ({
      id: t.id,
      description: t.description,
      model: t.model,
    })),
  });

  const ctx: OrchestratorContext = {
    parentId,
    complexity,
    subagentTasks,
    orchestratorEnabled: true,
    systemPromptInjected: true,
  };

  return { enrichedBody, ctx };
}

/**
 * Mark all subagent tasks as RUNNING when the actual model call begins.
 * Call this just before executeWithRetry / transformStream.
 */
export async function markOrchestrationRunning(ctx: OrchestratorContext): Promise<void> {
  if (!ctx.orchestratorEnabled) return;
  for (const task of ctx.subagentTasks) {
    await updateSubagentStatus(task.id, 'RUNNING').catch(() => {});
  }
}

/**
 * Finalise orchestration after the model call completes.
 * Phase 7: Persists final output and closes the orchestration (COMPLETED).
 * Phase 9: Stream-safe — calling this after stream end prevents re-entry.
 */
export async function finalizeOrchestration(
  ctx: OrchestratorContext,
  artifacts: string[] = [],
  finalOutput = '',
  latencyMs = 0
): Promise<void> {
  if (!ctx.orchestratorEnabled) return;

  for (const task of ctx.subagentTasks) {
    await updateSubagentStatus(task.id, 'COMPLETED', artifacts).catch(() => {});
    // Record performance data for dashboard metrics
    const role = inferRoleFromDescription(task.description);
    await recordSubagentPerformance({
      model: task.model,
      taskType: role,
      latencyMs: latencyMs || (Date.now() - task.createdAt),
      inputTokens: 0,
      outputTokens: 0,
      success: true,
    }).catch(() => {});
  }

  // Phase 7: Persist final output and transition to COMPLETED (prevents reopen)
  if (ctx.parentId) {
    await finalizeMerge(ctx.parentId, finalOutput).catch(() => {});
  }

  logOrchestrator('merge-completed', {
    parentId: ctx.parentId,
    subTaskCount: ctx.subagentTasks.length,
    artifactCount: artifacts.length,
  });
}

/**
 * Retrieve live subagent task state for a parent orchestration session.
 */
export async function getOrchestrationState(
  parentId: string
): Promise<SubagentTask[]> {
  return getSubagentTasksByParent(parentId);
}

/**
 * Run the full subagent execution pipeline for an orchestrator context.
 *
 * This is the "orchestrator-executed" upgrade:
 *   1. Schedule all subagent tasks with dependency resolution.
 *   2. Execute in parallel where safe.
 *   3. Merge results into a coherent final output.
 *   4. Finalize the orchestration context.
 *
 * Returns the merged output string, or null if not applicable.
 */
export async function runOrchestratedExecution(
  ctx: OrchestratorContext
): Promise<string | null> {
  if (!ctx.orchestratorEnabled || ctx.subagentTasks.length === 0) return null;

  logOrchestrator('task-decomposition', {
    parentId: ctx.parentId,
    subTaskCount: ctx.subagentTasks.length,
    subTasks: ctx.subagentTasks.map((t) => ({
      id: t.id,
      description: t.description,
      model: t.model,
    })),
  });

  // Execute all tasks through the scheduler
  const schedulerResult = await scheduleSubagentTasks(ctx.subagentTasks);

  logOrchestrator('subagent-completed', {
    parentId: ctx.parentId,
    completed: schedulerResult.completed.length,
    failed: schedulerResult.failed.length,
    skipped: schedulerResult.skipped.length,
    totalLatencyMs: schedulerResult.totalLatencyMs,
  });

  // Merge outputs
  const mergeResult = mergeSubagentOutputs(ctx.subagentTasks, schedulerResult);

  // Phase 7 + 9: Finalize with merged output — closes orchestration permanently
  await finalizeOrchestration(ctx, mergeResult.sourceTaskIds, mergeResult.output);

  logOrchestrator('merge-completed', {
    parentId: ctx.parentId,
    valid: mergeResult.validation.valid,
    sourceTaskCount: mergeResult.sourceTaskIds.length,
    totalOutputTokens: mergeResult.totalOutputTokens,
  });

  return mergeResult.output;
}

/**
 * Phase 6: Resume orchestrated execution after an overload recovery.
 *
 * Unlike runOrchestratedExecution, this only re-executes tasks that are
 * still PENDING or FAILED (not COMPLETED). This preserves completed
 * subagent work and avoids restarting the entire orchestration.
 */
export async function resumeOrchestratedExecution(
  ctx: OrchestratorContext
): Promise<string | null> {
  if (!ctx.orchestratorEnabled || ctx.subagentTasks.length === 0) return null;

  // Load current task states from Redis
  const liveTasks = await getSubagentTasksByParent(ctx.parentId);
  if (liveTasks.length === 0) return runOrchestratedExecution(ctx);

  // Filter to only tasks that still need execution
  const remainingTasks = liveTasks.filter(
    (t) => t.status === 'PENDING' || t.status === 'FAILED'
  );

  if (remainingTasks.length === 0) {
    logOrchestrator('subagent-completed', {
      parentId: ctx.parentId,
      action: 'resume-all-already-completed',
    });
    // All tasks already done — just merge
    const allTasks = liveTasks;
    // Build a synthetic scheduler result from completed tasks
    const schedulerResult = await scheduleSubagentTasks(allTasks);
    const mergeResult = mergeSubagentOutputs(allTasks, schedulerResult);
    await finalizeOrchestration(ctx, mergeResult.sourceTaskIds, mergeResult.output);
    return mergeResult.output;
  }

  logOrchestrator('orchestrator-status', {
    action: 'resume',
    parentId: ctx.parentId,
    remainingTasks: remainingTasks.length,
    completedTasks: liveTasks.length - remainingTasks.length,
  });

  // Re-run only remaining tasks
  const schedulerResult = await scheduleSubagentTasks(remainingTasks);

  logOrchestrator('subagent-completed', {
    parentId: ctx.parentId,
    resumed: true,
    completed: schedulerResult.completed.length,
    failed: schedulerResult.failed.length,
    skipped: schedulerResult.skipped.length,
  });

  // Merge ALL tasks (completed + newly completed)
  const mergeResult = mergeSubagentOutputs(liveTasks, schedulerResult);
  await finalizeOrchestration(ctx, mergeResult.sourceTaskIds, mergeResult.output);

  return mergeResult.output;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function injectOrchestratorPrompt(
  body: Record<string, unknown>
): Record<string, unknown> {
  const existing = typeof body.system === 'string' ? body.system : '';
  return {
    ...body,
    system: existing
      ? `${existing}\n\n${ORCHESTRATOR_SYSTEM_INJECTION}`
      : ORCHESTRATOR_SYSTEM_INJECTION,
  };
}

/** Map task description to a SubagentRole for performance tracking. */
function inferRoleFromDescription(description: string): SubagentRole {
  const d = description.toLowerCase();
  if (d.includes('plan') || d.includes('decompose')) return 'PLANNER';
  if (d.includes('coding') || d.includes('code') || d.includes('execute')) return 'CODER';
  if (d.includes('verify') || d.includes('check')) return 'VERIFIER';
  if (d.includes('merge')) return 'MERGER';
  return 'GENERIC';
}

async function createSubagentStubs(
  parentId: string,
  owner: string,
  level: ComplexityResult['level'],
  requestBody: unknown
): Promise<SubagentTask[]> {
  const tasks: SubagentTask[] = [];

  // Always include a coordinator planning sub-task.
  const plannerTask = createSubagentTask({
    parentId,
    owner,
    description: 'Coordinator: decompose task and produce execution plan',
    model: MODEL_ASSIGNMENTS.REASONING,
    dependencies: [],
  });
  tasks.push(plannerTask);

  if (level === 'COMPLEX' || level === 'MULTI_STAGE') {
    const codeTask = createSubagentTask({
      parentId,
      owner,
      description: 'Subagent: execute coding sub-tasks per plan',
      model: MODEL_ASSIGNMENTS.CODING,
      dependencies: [plannerTask.id],
    });
    tasks.push(codeTask);

    const verifyTask = createSubagentTask({
      parentId,
      owner,
      description: 'Subagent: verify sub-task outputs',
      model: MODEL_ASSIGNMENTS.FAST_CHECK,
      dependencies: [codeTask.id],
    });
    tasks.push(verifyTask);
  }

  if (level === 'MULTI_STAGE') {
    const mergeTask = createSubagentTask({
      parentId,
      owner,
      description: 'Coordinator: merge all sub-task results into final answer',
      model: MODEL_ASSIGNMENTS.CODING,
      dependencies: tasks.map((t) => t.id),
    });
    tasks.push(mergeTask);
  }

  // Persist all stubs to Redis.
  await Promise.all(tasks.map((t) => saveSubagentTask(t)));

  logOrchestrator('subagents-assigned', {
    parentId,
    tasks: tasks.map((t) => ({ id: t.id, model: t.model, description: t.description })),
  });

  return tasks;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

type OrchestratorEvent =
  | 'orchestrator-status'
  | 'task-decomposition'
  | 'subagents-assigned'
  | 'subagent-completed'
  | 'merge-completed';

function logOrchestrator(event: OrchestratorEvent, data: Record<string, unknown>): void {
  console.info(`[orchestrator] event=${event}`, JSON.stringify(data));
}
