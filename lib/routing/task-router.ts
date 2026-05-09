export type TaskType =
  | 'REASONING'
  | 'HEAVY_CODING'
  | 'LIGHT_CODING'
  | 'HEALTH_CHECK'
  | 'COMPACTION';

export interface TaskClassification {
  type: TaskType;
  reason: string;
}

const REASONING_CHAIN = [
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];

const HEAVY_CODING_CHAIN = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];

const LIGHT_CODING_CHAIN = [
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
];

const HEALTH_CHECK_CHAIN = [
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
];

const COMPACTION_CHAIN = [
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
  'gemini-2.5-flash',
];

function extractLatestUserText(requestBody: any): string {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    const content = messages[i]?.content;
    if (typeof content === 'string') return content.toLowerCase();
    if (Array.isArray(content)) {
      return content
        .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
        .join(' ')
        .toLowerCase();
    }
  }
  return '';
}

export function classifyTaskType(requestBody: any, thinkingEnabled = false): TaskClassification {
  const text = extractLatestUserText(requestBody);
  const toolCount = Array.isArray(requestBody?.tools) ? requestBody.tools.length : 0;

  if (/health|status|heartbeat|ping|check\s+service|diagnostic/i.test(text)) {
    return { type: 'HEALTH_CHECK', reason: 'health-check-keywords' };
  }

  if (/compaction|compact|summarize\s+history|memory\s+compression|context\s+compression/i.test(text)) {
    return { type: 'COMPACTION', reason: 'compaction-keywords' };
  }

  if (
    thinkingEnabled ||
    /contradiction|dependency\s+reasoning|operational\s+memory|error\s+interpretation|analy[sz]e|reason|root cause|investigate|plan/i.test(text)
  ) {
    return { type: 'REASONING', reason: thinkingEnabled ? 'thinking-enabled' : 'reasoning-keywords' };
  }

  if (
    toolCount >= 3 ||
    /multi-file|architecture|full-stack|generate\s+.*(app|project|system)|orchestrat|refactor\s+and\s+rebuild/i.test(text)
  ) {
    return { type: 'HEAVY_CODING', reason: toolCount >= 3 ? 'high-tool-count' : 'heavy-coding-keywords' };
  }

  if (/quick fix|small fix|minor|lint|format|key validation|validate key|tiny/i.test(text)) {
    return { type: 'LIGHT_CODING', reason: 'light-coding-keywords' };
  }

  return { type: 'HEAVY_CODING', reason: 'default-heavy-coding' };
}

export function getTaskModelChain(taskType: TaskType): string[] {
  switch (taskType) {
    case 'REASONING':
      return [...REASONING_CHAIN];
    case 'HEAVY_CODING':
      return [...HEAVY_CODING_CHAIN];
    case 'LIGHT_CODING':
      return [...LIGHT_CODING_CHAIN];
    case 'HEALTH_CHECK':
      return [...HEALTH_CHECK_CHAIN];
    case 'COMPACTION':
      return [...COMPACTION_CHAIN];
    default:
      return [...HEAVY_CODING_CHAIN];
  }
}
