import type { RuntimeContextEnvelope } from './contracts';

export interface RuntimeCostDecision {
  promptReuseKey: string;
  contextPressure: 'low' | 'medium' | 'high';
  recommendedMode: 'direct' | 'cached' | 'compact';
}

function hashSummary(summary: string) {
  let hash = 0;
  for (let index = 0; index < summary.length; index += 1) {
    hash = ((hash << 5) - hash) + summary.charCodeAt(index);
    hash |= 0;
  }
  return `ctx_${Math.abs(hash)}`;
}

export class RuntimeCostOptimizer {
  decide(context: RuntimeContextEnvelope): RuntimeCostDecision {
    const pressure = context.tokenBudget >= 12000
      ? 'low'
      : context.tokenBudget >= 8000
        ? 'medium'
        : 'high';

    return {
      promptReuseKey: hashSummary(`${context.summary}\n${context.selectedFiles.join('|')}`),
      contextPressure: pressure,
      recommendedMode: pressure === 'high' ? 'compact' : context.rankedItems.length > 6 ? 'cached' : 'direct',
    };
  }
}
