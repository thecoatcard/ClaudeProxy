import type { AgentSession, AgentTaskNode, ModelExecutionResponse, ValidationResult } from './contracts';

export interface ReflectionResult {
  /** Whether the overall execution was successful from a runtime perspective. */
  success: boolean;
  /** Human-readable summary of the reflection outcome. */
  summary: string;
  /** IDs of tasks that failed during execution. */
  failedTasks: string[];
  /**
   * When true, the runtime loop should replan instead of immediately failing.
   * Set when content quality is low or validation failed with recoverable causes.
   */
  shouldReplan: boolean;
  /** Reason passed to the planner when shouldReplan is true. */
  replanReason?: string;
  /**
   * When true, the runtime loop should retry the current task cycle.
   * Set when a transient error (timeout, empty content) is detected.
   */
  shouldRetry: boolean;
  /** Confidence score [0–1] measuring execution quality. */
  qualityScore: number;
  /** Signals used by the planner to select the best recovery strategy. */
  signals: ReflectionSignal[];
}

export type ReflectionSignalKind =
  | 'empty_content'
  | 'tool_failure'
  | 'validation_failure'
  | 'partial_completion'
  | 'goal_met'
  | 'low_confidence'
  | 'no_tool_progress'
  | 'critical_task_failed';

export interface ReflectionSignal {
  kind: ReflectionSignalKind;
  detail: string;
  severity: 'info' | 'warning' | 'error';
}

/**
 * ReflectionEngine evaluates the outcome of a model execution cycle and
 * determines whether the runtime should complete, replan, or retry.
 *
 * DESIGN PRINCIPLES:
 * - Does NOT call any external services.
 * - Based entirely on session state + validation results + response structure.
 * - Returns structured ReflectionResult that drives loop decisions.
 * - Quality score is a composite of: content quality, tool coverage, validation
 *   outcome, and task completion coverage.
 */
export class ReflectionEngine {
  reflect(
    session: AgentSession,
    response: ModelExecutionResponse,
    validation: ValidationResult,
  ): ReflectionResult {
    const signals: ReflectionSignal[] = [];
    const failedTasks = session.tasks
      .filter((task) => task.status === 'FAILED')
      .map((task) => task.id);
    const completedTasks = session.tasks
      .filter((task) => task.status === 'COMPLETED')
      .map((task) => task.id);

    // ── Content analysis ─────────────────────────────────────────────────────
    const hasContent = Array.isArray(response?.content) && response.content.length > 0;
    const textBlocks = Array.isArray(response?.content)
      ? response.content.filter(
          (block) => typeof block === 'object' && block !== null && 'type' in block && (block as Record<string, unknown>).type === 'text',
        )
      : [];
    const toolBlocks = Array.isArray(response?.content)
      ? response.content.filter(
          (block) => typeof block === 'object' && block !== null && 'type' in block && (block as Record<string, unknown>).type === 'tool_use',
        )
      : [];
    const totalTextLength = textBlocks.reduce((acc, block) => {
      const text = typeof (block as Record<string, unknown>).text === 'string'
        ? (block as Record<string, unknown>).text as string
        : '';
      return acc + text.length;
    }, 0);

    if (!hasContent) {
      signals.push({ kind: 'empty_content', detail: 'Model returned no content blocks.', severity: 'error' });
    } else if (textBlocks.length === 0 && toolBlocks.length === 0) {
      signals.push({ kind: 'empty_content', detail: 'Model returned content but no text or tool blocks.', severity: 'warning' });
    } else if (textBlocks.length > 0 && totalTextLength < 20) {
      signals.push({ kind: 'low_confidence', detail: `Model response text is extremely short (${totalTextLength} chars).`, severity: 'warning' });
    }

    // ── Tool execution analysis ────────────────────────────────────────────
    const toolFacts = session.memory.toolExecutionFacts ?? [];
    const recentToolFacts = toolFacts.slice(-10);
    const consecutiveToolFailures = recentToolFacts.filter((fact) =>
      typeof fact.value === 'string' && fact.value.includes(':error'),
    ).length;

    if (consecutiveToolFailures >= 3) {
      signals.push({
        kind: 'tool_failure',
        detail: `${consecutiveToolFailures} consecutive tool failures detected.`,
        severity: 'error',
      });
    }

    if (session.modifiedFiles.length === 0 && toolBlocks.length === 0 && session.tasks.some(
      (t) => t.kind === 'model_execution' && t.attempts && t.attempts > 1,
    )) {
      signals.push({
        kind: 'no_tool_progress',
        detail: 'Multiple execution attempts produced no file modifications or tool calls.',
        severity: 'warning',
      });
    }

    // ── Validation analysis ────────────────────────────────────────────────
    if (validation.status === 'failed') {
      const isCritical = validation.details.some(
        (d) => /build failed|compilation error|syntax error/i.test(d),
      );
      signals.push({
        kind: 'validation_failure',
        detail: `Validation failed: ${validation.details.join('; ')}`,
        severity: isCritical ? 'error' : 'warning',
      });
    }

    // ── Task coverage ──────────────────────────────────────────────────────
    const criticalTasks = ['model-execution', 'validation', 'reflection'];
    const failedCritical = failedTasks.filter((id) => criticalTasks.includes(id));
    if (failedCritical.length > 0) {
      signals.push({
        kind: 'critical_task_failed',
        detail: `Critical tasks failed: ${failedCritical.join(', ')}`,
        severity: 'error',
      });
    }

    const totalNonTrivialTasks = session.tasks.filter(
      (t) => !['completion', 'memory-update'].includes(t.id),
    );
    const completionRate = totalNonTrivialTasks.length > 0
      ? completedTasks.filter((id) => !['completion', 'memory-update'].includes(id)).length / totalNonTrivialTasks.length
      : 1;
    if (completionRate < 0.5) {
      signals.push({ kind: 'partial_completion', detail: `Only ${Math.round(completionRate * 100)}% of tasks completed.`, severity: 'warning' });
    }

    // ── Quality score ──────────────────────────────────────────────────────
    let qualityScore = 1.0;
    for (const signal of signals) {
      switch (signal.severity) {
        case 'error':   qualityScore -= 0.3; break;
        case 'warning': qualityScore -= 0.1; break;
        default:        break;
      }
    }
    qualityScore = Math.max(0, Math.min(1, qualityScore));

    // ── Decision logic ─────────────────────────────────────────────────────
    const hasErrorSignals = signals.some((s) => s.severity === 'error');
    const hasWarningSignals = signals.some((s) => s.severity === 'warning');
    const emptyContentSignal = signals.find((s) => s.kind === 'empty_content');
    const validationFailed = signals.find((s) => s.kind === 'validation_failure');
    const noProgress = signals.find((s) => s.kind === 'no_tool_progress');

    // Success: no errors, content present, validation passed
    if (!hasErrorSignals && !hasWarningSignals && validation.status !== 'failed') {
      signals.push({ kind: 'goal_met', detail: 'All quality checks passed.', severity: 'info' });
      return {
        success: true,
        summary: `Execution completed with quality score ${qualityScore.toFixed(2)} and ${session.artifacts.length} artifact(s).`,
        failedTasks,
        shouldReplan: false,
        shouldRetry: false,
        qualityScore,
        signals,
      };
    }

    // Retry: empty content from model (transient — model didn't respond)
    if (emptyContentSignal && failedTasks.length === 0) {
      return {
        success: false,
        summary: 'Model returned empty content — retrying.',
        failedTasks,
        shouldReplan: false,
        shouldRetry: true,
        qualityScore,
        signals,
      };
    }

    // Replan: validation failed with recoverable causes or no tool progress
    const isRecoverableValidation = validationFailed && !signals.some((s) => s.kind === 'critical_task_failed');
    const isStuckWithoutProgress = noProgress && qualityScore > 0.3;
    if (isRecoverableValidation || isStuckWithoutProgress) {
      const reason = isRecoverableValidation
        ? `Validation failed: ${validationFailed!.detail}`
        : `No tool progress after multiple attempts`;
      return {
        success: false,
        summary: reason,
        failedTasks,
        shouldReplan: true,
        replanReason: reason,
        shouldRetry: false,
        qualityScore,
        signals,
      };
    }

    // Failure: critical errors that cannot be recovered automatically
    return {
      success: false,
      summary: hasErrorSignals
        ? `Execution failed: ${signals.filter((s) => s.severity === 'error').map((s) => s.detail).join('; ')}`
        : 'Execution completed with warnings.',
      failedTasks,
      shouldReplan: false,
      shouldRetry: false,
      qualityScore,
      signals,
    };
  }
}
