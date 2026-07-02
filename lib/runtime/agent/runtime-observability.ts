type CounterKey = string;

interface TimerSample {
  count: number;
  totalMs: number;
  maxMs: number;
}

interface ToolMetric {
  calls: number;
  totalMs: number;
  errors: number;
}

const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'gemini-2.5-flash': { inputPerM: 0.075, outputPerM: 0.3 },
  'gemini-2.5-flash-lite': { inputPerM: 0.0375, outputPerM: 0.15 },
  'gemini-3-flash-preview': { inputPerM: 0.075, outputPerM: 0.3 },
  'gemma-4-31b-it': { inputPerM: 0.15, outputPerM: 0.6 },
  'gemma-4-26b-a4b-it': { inputPerM: 0.15, outputPerM: 0.6 },
  'claude-3-5-sonnet': { inputPerM: 3.0, outputPerM: 15.0 },
};

export class RuntimeObservability {
  private readonly counters = new Map<CounterKey, number>();
  private readonly timers = new Map<string, TimerSample>();
  private readonly tools = new Map<string, ToolMetric>();
  private totalCostUsd = 0;

  increment(metric: string, value = 1) {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + value);
  }

  recordDuration(metric: string, durationMs: number) {
    const current = this.timers.get(metric) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    this.timers.set(metric, current);
  }

  /**
   * Tracks execution performance and failures per tool.
   */
  recordToolCall(toolName: string, durationMs: number, success: boolean) {
    const current = this.tools.get(toolName) ?? { calls: 0, totalMs: 0, errors: 0 };
    current.calls += 1;
    current.totalMs += durationMs;
    if (!success) {
      current.errors += 1;
    }
    this.tools.set(toolName, current);
    this.increment('total_tool_calls');
    if (!success) this.increment('total_tool_errors');
  }

  /**
   * Records token costs dynamically based on model billing definitions.
   */
  recordCost(modelName: string, inputTokens: number, outputTokens: number) {
    const matched = Object.keys(MODEL_PRICING).find((m) => modelName.toLowerCase().includes(m)) ?? 'gemini-2.5-flash';
    const rates = MODEL_PRICING[matched] ?? { inputPerM: 0.075, outputPerM: 0.3 };
    const cost = ((inputTokens / 1_000_000) * rates.inputPerM) + ((outputTokens / 1_000_000) * rates.outputPerM);
    this.totalCostUsd += cost;
    this.increment('tokens_input', inputTokens);
    this.increment('tokens_output', outputTokens);
  }

  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      timers: Object.fromEntries(
        Array.from(this.timers.entries()).map(([metric, sample]) => [
          metric,
          {
            ...sample,
            avgMs: sample.count === 0 ? 0 : Number((sample.totalMs / sample.count).toFixed(2)),
          },
        ]),
      ),
      tools: Object.fromEntries(
        Array.from(this.tools.entries()).map(([tool, metric]) => [
          tool,
          {
            ...metric,
            avgMs: metric.calls === 0 ? 0 : Number((metric.totalMs / metric.calls).toFixed(2)),
          },
        ]),
      ),
      totalCostUsd: Number(this.totalCostUsd.toFixed(6)),
    };
  }
}

export const globalRuntimeObservability = new RuntimeObservability();
