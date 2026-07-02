import { NextResponse } from 'next/server';
import type { ModelRoute } from '@/lib/model-router';
import type { AgentSession, ModelExecutionResponse, RuntimeContextEnvelope } from './contracts';
import { CheckpointManager } from './checkpoint-manager';
import { SessionCancellationSignal } from './cancellation';
import { ExecutionEngine } from './execution-engine';
import { LlmGateway } from './llm-gateway';
import { Planner } from './planner';
import { RecoveryManager } from './recovery-manager';
import { RuntimeRetryManager } from './retry-manager';
import { SessionManager } from './session-manager';
import { MemoryManager } from './memory-manager';
import { ToolExecutor } from './tool-executor';
import { ToolRegistry } from './tool-registry';

/**
 * Default maximum number of autonomous execution cycles.
 * Can be overridden per-run via options.maxCycles.
 *
 * - Default: 20 (sufficient for complex multi-phase tasks)
 * - Hard cap: 50 (prevents runaway agents)
 * - Override minimum: 1
 */
const DEFAULT_MAX_CYCLES = 20;
const HARD_MAX_CYCLES = 50;

interface RunLoopOptions {
  session: AgentSession;
  body: Record<string, unknown>;
  requestedModel: string;
  route: ModelRoute;
  requestId: string;
  token: string;
  startedAt: number;
  context: RuntimeContextEnvelope;
  runtimePlan: string;
  sessions: SessionManager;
  execution: ExecutionEngine;
  llm: LlmGateway;
  planner: Planner;
  retry: RuntimeRetryManager;
  checkpoints: CheckpointManager;
  recovery: RecoveryManager;
  cancellation: SessionCancellationSignal;
  toolExecutor: ToolExecutor;
  toolRegistry: ToolRegistry;
  memory: MemoryManager;
  analysisSummary?: string;
  /** Maximum autonomous execution cycles. Defaults to DEFAULT_MAX_CYCLES. */
  maxCycles?: number;
}

export class RuntimeExecutionLoop {
  async run(options: RunLoopOptions) {
    await options.sessions.transitionRuntimeState(options.session, 'Initializing', 'observe_request');
    await this.createCheckpoint(options, 'initializing');

    await options.sessions.transitionRuntimeState(options.session, 'Planning', 'build_execution_plan');
    await this.createCheckpoint(options, 'planning_ready');

    const workingBody: Record<string, unknown> = JSON.parse(JSON.stringify(options.body));
    const maxCycles = Math.min(
      Math.max(options.maxCycles ?? DEFAULT_MAX_CYCLES, 1),
      HARD_MAX_CYCLES,
    );
    let cycle = 0;
    let consecutiveReplanCycles = 0;
    const MAX_REPLAN_CYCLES = 3; // prevent infinite replan loops

    while (cycle < maxCycles) {
      cycle += 1;
      if (await options.cancellation.refresh()) {
        await options.sessions.cancel(options.session, 'Cancellation requested before execution loop step');
        return NextResponse.json({ error: { type: 'cancelled', message: 'Session cancelled.' } }, { status: 409 });
      }

      try {
        await options.sessions.transitionRuntimeState(options.session, 'Executing', 'model_execution_started', {
          resolvedModel: options.route.primary,
          cycle,
          maxCycles,
        });

        const task = options.session.tasks.find((candidate) => candidate.id === 'model-execution');
        if (task?.status !== 'RUNNING') {
          await options.sessions.startTask(options.session, 'model-execution');
        }

        const response = await options.llm.execute({
          body: workingBody,
          requestedModel: options.requestedModel,
          internalModel: options.route.primary,
          token: options.token,
          route: options.route,
          requestId: options.requestId,
          runtimeSummary: options.context.summary,
          runtimePlan: options.runtimePlan,
          cancellation: options.cancellation,
        });

        if (await options.cancellation.refresh()) {
          await options.sessions.cancel(options.session, 'Cancellation requested during model execution');
          return NextResponse.json({ error: { type: 'cancelled', message: 'Session cancelled during execution.' } }, { status: 409 });
        }

        const toolUses = Array.isArray(response.content)
          ? response.content.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_use')
          : [];

        if (toolUses.length > 0) {
          await options.sessions.transitionRuntimeState(options.session, 'Waiting Tool', 'executing_tool_calls', {
            cycle,
            toolCount: toolUses.length,
          });

          const toolResults: Array<Record<string, unknown>> = [];
          for (const block of toolUses) {
            const toolUseId = typeof block.id === 'string' ? block.id : `toolu_${Math.random().toString(36).slice(2, 10)}`;
            const toolName = typeof block.name === 'string' ? block.name : '';
            const input = typeof block.input === 'object' && block.input ? block.input as Record<string, unknown> : {};
            const invocation = options.toolRegistry.resolveToolCall(toolName, input);
            if (!invocation) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: `Unknown runtime tool: ${toolName}`,
                is_error: true,
              });
              options.memory.update(options.session.memory, `Unknown runtime tool requested: ${toolName}`, 'runtime-loop', 'tool_execution', 0.2);
              continue;
            }
            const toolResult = await options.toolExecutor.execute(
              options.session,
              invocation,
              {
                sessionId: options.session.id,
                ownerId: options.session.ownerId,
                workspaceRoot: options.session.workspace.root,
                requestId: `${options.requestId}:tool:${toolUseId}`,
                cancellation: options.cancellation,
              },
              options.sessions,
            );

            if (toolResult.status === 'approval_required') {
              await options.sessions.transitionRuntimeState(options.session, 'Waiting Approval', 'waiting_for_tool_approval', {
                tool: toolName,
                operation: toolResult.operation,
              });
              return NextResponse.json({
                error: {
                  type: 'approval_required',
                  message: toolResult.approval?.reason ?? 'Tool approval is required.',
                },
                approval: toolResult.approval,
              }, { status: 409 });
            }

            options.memory.update(
              options.session.memory,
              `${toolName} returned ${toolResult.status}`,
              'tool-runtime',
              'tool_execution',
              toolResult.status === 'success' ? 0.85 : 0.35,
            );
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: JSON.stringify(toolResult.output ?? { error: toolResult.error ?? 'Tool failed' }),
              is_error: toolResult.status !== 'success',
            });
          }

          const currentMessages = Array.isArray(workingBody.messages) ? [...workingBody.messages] : [];
          currentMessages.push({ role: 'assistant', content: response.content ?? [] });
          currentMessages.push({ role: 'user', content: toolResults });
          workingBody.messages = currentMessages;
          options.session.tasks = options.planner.replanAfterFailure(
            options.session.tasks,
            'model-execution',
            `tool_cycle_${cycle}`,
          );

          await options.sessions.transitionRuntimeState(options.session, 'Reflecting', 'tool_results_observed', {
            cycle,
            toolCount: toolResults.length,
          });
          await options.sessions.transitionRuntimeState(options.session, 'Planning', 'planning_after_tool_results', { cycle });
          await this.createCheckpoint(options, `tool_cycle_${cycle}`);
          continue;
        }

        // ── No tool calls: finalize session ───────────────────────────────
        await options.sessions.finishTask(options.session, 'model-execution', {
          mode: 'response',
          contentBlocks: Array.isArray(response?.content) ? response.content.length : 0,
          cycle,
        });
        await options.sessions.transitionRuntimeState(options.session, 'Reflecting', 'reflecting_on_execution');
        const validation = await options.execution.finalizeSession(options.session, response);

        // ── Approval gate from validation ─────────────────────────────────
        if (validation.status === 'failed' && validation.checks.includes('runtime_tool_validation')) {
          const approvalPending = validation.details.some((detail) => /approval/i.test(detail));
          if (approvalPending) {
            await options.sessions.transitionRuntimeState(options.session, 'Waiting Approval', 'waiting_for_tool_approval', {
              details: validation.details,
            });
            return NextResponse.json({ error: { type: 'approval_required', message: validation.details.join(' ') } }, { status: 409 });
          }
          await options.sessions.transitionRuntimeState(options.session, 'Waiting Tool', 'waiting_for_tool_completion', {
            details: validation.details,
          });
        }

        // ── Dynamic replanning from ReflectionEngine ──────────────────────
        // The ReflectionEngine now returns structured signals. If it signals
        // shouldReplan and we haven't exhausted the replan budget, continue the loop.
        const reflectionResult = options.session.lastReflection as (typeof validation & {
          shouldReplan?: boolean;
          shouldRetry?: boolean;
          replanReason?: string;
        }) | undefined;

        if (reflectionResult?.shouldRetry && consecutiveReplanCycles < MAX_REPLAN_CYCLES) {
          consecutiveReplanCycles += 1;
          await options.sessions.transitionRuntimeState(options.session, 'Retrying', 'reflection_triggered_retry', {
            cycle,
            reason: 'Model returned empty content — retrying',
          });
          options.session.tasks = options.planner.replanAfterFailure(
            options.session.tasks,
            'model-execution',
            'reflection_triggered_retry',
          );
          await options.sessions.resetTaskForRetry(options.session, 'model-execution', 'reflection_triggered_retry');
          await this.createCheckpoint(options, `reflection_retry_${cycle}`);
          continue;
        }

        if (reflectionResult?.shouldReplan && consecutiveReplanCycles < MAX_REPLAN_CYCLES) {
          consecutiveReplanCycles += 1;
          const replanReason = reflectionResult.replanReason ?? 'reflection_triggered_replan';
          await options.sessions.transitionRuntimeState(options.session, 'Planning', 'reflection_triggered_replan', {
            cycle,
            reason: replanReason,
          });
          options.session.tasks = options.planner.replanAfterFailure(
            options.session.tasks,
            'model-execution',
            replanReason,
          );
          await options.sessions.resetTaskForRetry(options.session, 'model-execution', replanReason);
          await this.createCheckpoint(options, `replan_${cycle}`);
          continue;
        }

        // Reset replan counter on a clean cycle
        consecutiveReplanCycles = 0;

        await options.sessions.transitionRuntimeState(
          options.session,
          options.session.status === 'COMPLETED' ? 'Completed' : 'Failed',
          options.session.status === 'COMPLETED' ? 'runtime_completed' : 'runtime_failed',
        );
        if (options.session.status === 'COMPLETED') {
          LlmGateway.finalizeSuccess({
            requestedModel: options.requestedModel,
            internalModel: options.route.primary,
            route: options.route,
            token: options.token,
            startedAt: options.startedAt,
            response: response as ModelExecutionResponse & { usage: { input_tokens: number; output_tokens: number } },
          });
        }
        return NextResponse.json(response);

      } catch (error) {
        options.recovery.annotateFailure(options.session, error);
        const task = options.session.tasks.find((candidate) => candidate.id === 'model-execution');
        const retryDecision = options.retry.decide(task ?? {
          id: 'model-execution',
          kind: 'model_execution',
          title: 'Model execution',
          detail: '',
          dependencies: [],
          status: 'FAILED',
        }, error);
        await options.sessions.failTask(
          options.session,
          'model-execution',
          error instanceof Error ? error.message : String(error),
        );

        if (retryDecision.shouldRetry) {
          await options.sessions.transitionRuntimeState(options.session, 'Retrying', 'retrying_model_execution', {
            reason: retryDecision.reason,
            attempt: retryDecision.nextAttempt,
            errorKind: retryDecision.errorKind,
            delayMs: retryDecision.delayMs,
            suggestProviderFallback: retryDecision.suggestProviderFallback,
          });
          options.session.tasks = options.planner.replanAfterFailure(
            options.session.tasks,
            'model-execution',
            retryDecision.reason,
          );
          await options.sessions.resetTaskForRetry(options.session, 'model-execution', retryDecision.reason);
          // Respect the computed backoff delay before the next cycle
          await options.retry.waitForDelay(retryDecision);
          await this.createCheckpoint(options, `retry_${retryDecision.nextAttempt}`);
          continue;
        }

        await options.sessions.transitionRuntimeState(options.session, 'Failed', 'runtime_failed', {
          error: options.session.lastError,
          errorKind: retryDecision.errorKind,
        });
        LlmGateway.finalizeError(options.requestedModel, options.token, error);
        return LlmGateway.handleFailure(error);
      }
    }

    await options.sessions.transitionRuntimeState(options.session, 'Failed', 'runtime_failed', {
      error: `Maximum autonomous cycles reached (${maxCycles})`,
    });
    return LlmGateway.handleFailure(new Error(`Maximum autonomous cycles reached (${maxCycles})`));
  }

  async resume(options: Omit<RunLoopOptions, 'body' | 'requestedModel' | 'route' | 'requestId' | 'token' | 'startedAt' | 'context' | 'runtimePlan'> & {
    body: Record<string, unknown>;
    requestedModel: string;
    route: ModelRoute;
    requestId: string;
    token: string;
    startedAt: number;
    context: RuntimeContextEnvelope;
    runtimePlan: string;
  }) {
    await options.sessions.transitionRuntimeState(options.session, 'Recovering', 'resume_requested');
    options.recovery.restore(options.session);
    await this.createCheckpoint(options, 'recovered');
    return this.run(options);
  }

  private async createCheckpoint(options: RunLoopOptions, label: string) {
    const checkpoint = options.checkpoints.create(options.session, label, {
      runtimePlanLength: options.runtimePlan.length,
      selectedFiles: options.context.selectedFiles,
    });
    await options.sessions.appendCheckpoint(options.session, checkpoint);
  }
}
