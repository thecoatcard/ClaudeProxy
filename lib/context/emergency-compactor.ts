import { callGemini } from '../gemini-adapter';
import { getHealthiestKeyObj } from '../key-manager';
import { logInfo, logWarn } from '../logging/event-logger';
import { redis } from '../redis';

const EMERGENCY_COMPACTOR_MODEL = 'gemma-4-31b-it';
const EMERGENCY_STATE_TTL_SECONDS = Number(process.env.EMERGENCY_COMPACTION_TTL_SECONDS || 21600);
const MAX_EMERGENCY_COMPACTIONS = 2;
const SUMMARY_MAX_OUTPUT_TOKENS = 900;
const SUMMARY_INPUT_CHAR_BUDGET = Number(process.env.EMERGENCY_COMPACTION_INPUT_CHARS || 24000);
const SUMMARY_BLOCK_HEADER = '[EMERGENCY COMPACTED CONTEXT]';
const SUMMARY_BLOCK_FOOTER = '[/EMERGENCY COMPACTED CONTEXT]';

export interface EmergencyCompactionRequestContext {
  conversationId?: string;
  summaryKey?: string;
  userId?: string;
  requestId?: string;
}

export interface EmergencyCompactionState {
  conversationId: string;
  summary: string;
  compactionCount: number;
  updatedAt: number;
}

export interface EmergencyCompactionStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface EmergencyCompactionResult {
  body: any;
  compacted: boolean;
  hardFallback: boolean;
  compactionCount: number;
  originalContents: number;
  compactedContents: number;
  reducedChars: number;
  summary: string | null;
}

export interface EmergencyCompactionDependencies {
  store?: EmergencyCompactionStore;
  summarizeMiddle?: (middleContents: any[], compactionCount: number) => Promise<string | null>;
}

const redisStore: EmergencyCompactionStore = {
  async get(key) {
    const value = await redis.get<string>(key).catch(() => null);
    return typeof value === 'string' ? value : null;
  },
  async set(key, value, ttlSeconds) {
    await redis.set(key, value, { ex: ttlSeconds }).catch(() => {});
  },
};

function emergencyStateKey(conversationId: string): string {
  return `context:emergency:${conversationId}`;
}

function getRetentionPlan(compactionCount: number) {
  if (compactionCount >= 2) {
    return { keepHead: 1, keepTail: 3 };
  }
  return { keepHead: 2, keepTail: 5 };
}

function estimateTextSize(body: any): number {
  try {
    return JSON.stringify(body).length;
  } catch {
    return 0;
  }
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function partToText(part: any): string {
  if (!part) return '';
  if (typeof part.text === 'string') return part.text;
  if (part.functionCall) {
    return `[tool_call] ${part.functionCall.name}(${clip(JSON.stringify(part.functionCall.args || {}), 600)})`;
  }
  if (part.functionResponse) {
    return `[tool_result] ${part.functionResponse.name}: ${clip(JSON.stringify(part.functionResponse.response || {}), 1200)}`;
  }
  if (part.inlineData) return '[inline_data omitted]';
  if (part.fileData) return `[file_data] ${part.fileData.fileUri || 'uri'}`;
  return clip(JSON.stringify(part), 500);
}

function contentsToTranscript(contents: any[]): string {
  return contents.map((entry) => {
    const role = entry?.role === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(entry?.parts) ? entry.parts.map(partToText).filter(Boolean).join('\n') : '';
    return `${role.toUpperCase()}: ${parts}`;
  }).join('\n\n');
}

function buildSummaryPrompt(transcript: string, compactionCount: number): string {
  const reductionGoal = compactionCount === 1 ? 'Remove roughly 60% of older turns.' : 'Remove an additional 30% of older turns.';
  return [
    'You are an overload emergency compactor for a coding gateway.',
    'Compress only the older context so the current execution can continue with a smaller payload.',
    reductionGoal,
    'Preserve exactly these categories:',
    '- latest intent and active task chain',
    '- pending tasks and next actions',
    '- tool state and unfinished tool/result links',
    '- artifact references and important file paths',
    '- failure history and what already did not work',
    '- operational memory needed to continue safely',
    'Return only this schema:',
    SUMMARY_BLOCK_HEADER,
    'Goal:',
    'LatestTurns:',
    'ActiveTaskChain:',
    'PendingTasks:',
    'ToolState:',
    'Artifacts:',
    'Failures:',
    'OperationalMemory:',
    SUMMARY_BLOCK_FOOTER,
    '',
    'OLDER CONTEXT TO COMPRESS:',
    clip(transcript, SUMMARY_INPUT_CHAR_BUDGET),
  ].join('\n');
}

function buildFallbackSummary(middleContents: any[], compactionCount: number): string {
  const transcript = clip(contentsToTranscript(middleContents), 4000);
  const reductionGoal = compactionCount === 1 ? 'older turns reduced by ~60%' : 'older turns reduced by an additional ~30%';
  return [
    SUMMARY_BLOCK_HEADER,
    'Goal: Continue the active coding task after overload recovery.',
    `LatestTurns: Emergency fallback summary generated because the compaction model was unavailable; ${reductionGoal}.`,
    `ActiveTaskChain: ${transcript.slice(0, 700) || 'No preserved task chain.'}`,
    'PendingTasks: Continue from the latest retained turns and unresolved tool actions.',
    'ToolState: Preserve the most recent tool call/result dependency chain from the retained tail.',
    'Artifacts: Preserve referenced files and outputs mentioned in the retained turns.',
    `Failures: ${transcript.slice(700, 1400) || 'No explicit failures captured.'}`,
    'OperationalMemory: Keep current execution continuity; do not restart completed steps.',
    SUMMARY_BLOCK_FOOTER,
  ].join('\n');
}

async function summarizeWithGemma(middleContents: any[], compactionCount: number, userId?: string): Promise<string | null> {
  const transcript = contentsToTranscript(middleContents);
  if (!transcript.trim()) return null;

  const keyObj = await getHealthiestKeyObj(userId);
  if (!keyObj?.key) return null;

  const body = {
    contents: [{ role: 'user', parts: [{ text: buildSummaryPrompt(transcript, compactionCount) }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
    ],
  };

  try {
    const response = await callGemini(EMERGENCY_COMPACTOR_MODEL, keyObj.key, body, false);
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const parts = payload?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.find((part: any) => typeof part?.text === 'string' && part.text.trim())?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

function mergeAdjacentContents(contents: any[]): any[] {
  const merged: any[] = [];
  for (const entry of contents) {
    const parts = Array.isArray(entry?.parts) ? entry.parts.filter(Boolean) : [];
    if (!parts.length) continue;
    const role = entry?.role === 'model' ? 'model' : 'user';
    const previous = merged[merged.length - 1];
    if (previous && previous.role === role) {
      previous.parts.push(...parts);
    } else {
      merged.push({ role, parts: [...parts] });
    }
  }
  if (!merged.length) return [{ role: 'user', parts: [{ text: 'Continue' }] }];
  if (merged[0].role !== 'user') {
    merged.unshift({ role: 'user', parts: [{ text: 'Continue from the compacted context.' }] });
  }
  if (merged[merged.length - 1].role === 'model') {
    merged.push({ role: 'user', parts: [{ text: 'Continue' }] });
  }
  return merged;
}

function buildGeminiSummaryEntry(summary: string) {
  return { role: 'user', parts: [{ text: summary }] };
}

function buildAnthropicSummaryMessage(summary: string) {
  return { role: 'assistant', content: [{ type: 'text', text: summary }] };
}

export async function loadEmergencyCompactionState(
  conversationId: string | undefined,
  store: EmergencyCompactionStore = redisStore,
): Promise<EmergencyCompactionState | null> {
  if (!conversationId) return null;
  const raw = await store.get(emergencyStateKey(conversationId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EmergencyCompactionState;
    if (!parsed?.conversationId || typeof parsed.summary !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function persistEmergencyCompactionState(
  state: EmergencyCompactionState,
  summaryKey: string | undefined,
  store: EmergencyCompactionStore = redisStore,
): Promise<void> {
  await store.set(emergencyStateKey(state.conversationId), JSON.stringify(state), EMERGENCY_STATE_TTL_SECONDS);
  if (summaryKey) {
    await store.set(summaryKey, state.summary, EMERGENCY_STATE_TTL_SECONDS);
  }
}

export function applyCanonicalEmergencyState(messages: any[], state: EmergencyCompactionState | null): any[] {
  if (!state || !Array.isArray(messages) || messages.length === 0) return messages;
  const alreadyCompacted = messages.some((message) => {
    if (typeof message?.content === 'string') return message.content.includes(SUMMARY_BLOCK_HEADER);
    if (!Array.isArray(message?.content)) return false;
    return message.content.some((block: any) => typeof block?.text === 'string' && block.text.includes(SUMMARY_BLOCK_HEADER));
  });
  if (alreadyCompacted) return messages;

  const plan = getRetentionPlan(state.compactionCount);
  const keepHead = Math.min(plan.keepHead, messages.length);
  const maxTail = Math.max(1, messages.length - keepHead);
  const keepTail = Math.min(plan.keepTail, maxTail);
  const head = messages.slice(0, keepHead);
  const tail = messages.slice(-keepTail);
  return [...head, buildAnthropicSummaryMessage(state.summary), ...tail];
}

export async function performEmergencyCompaction(
  body: any,
  context: EmergencyCompactionRequestContext,
  dependencies: EmergencyCompactionDependencies = {},
): Promise<EmergencyCompactionResult> {
  const store = dependencies.store || redisStore;
  const currentState = await loadEmergencyCompactionState(context.conversationId, store);
  const currentCount = currentState?.compactionCount ?? 0;
  const originalContents = Array.isArray(body?.contents) ? body.contents.length : 0;
  const originalSize = estimateTextSize(body);

  if (currentCount >= MAX_EMERGENCY_COMPACTIONS) {
    return {
      body,
      compacted: false,
      hardFallback: true,
      compactionCount: currentCount,
      originalContents,
      compactedContents: originalContents,
      reducedChars: 0,
      summary: currentState?.summary ?? null,
    };
  }

  if (!Array.isArray(body?.contents) || body.contents.length < 8) {
    return {
      body,
      compacted: false,
      hardFallback: false,
      compactionCount: currentCount,
      originalContents,
      compactedContents: originalContents,
      reducedChars: 0,
      summary: currentState?.summary ?? null,
    };
  }

  const nextCount = currentCount + 1;
  const plan = getRetentionPlan(nextCount);
  const keepHead = Math.min(plan.keepHead, body.contents.length);
  const keepTail = Math.min(plan.keepTail, Math.max(1, body.contents.length - keepHead));
  const middleStart = keepHead;
  const middleEnd = Math.max(keepHead, body.contents.length - keepTail);
  const middleContents = body.contents.slice(middleStart, middleEnd);

  if (!middleContents.length) {
    return {
      body,
      compacted: false,
      hardFallback: false,
      compactionCount: currentCount,
      originalContents,
      compactedContents: originalContents,
      reducedChars: 0,
      summary: currentState?.summary ?? null,
    };
  }

  logInfo('OVERLOAD', 'EMERGENCY_COMPACTION_STARTED', {
    requestId: context.requestId,
    metadata: {
      conversationId: context.conversationId,
      compactionCount: nextCount,
      originalContents,
      keepHead,
      keepTail,
    },
  });

  const summarizeMiddle = dependencies.summarizeMiddle
    ? dependencies.summarizeMiddle
    : (contents: any[], compactionCount: number) => summarizeWithGemma(contents, compactionCount, context.userId);

  let summary = await summarizeMiddle(middleContents, nextCount);
  if (!summary || !summary.includes(SUMMARY_BLOCK_HEADER)) {
    summary = buildFallbackSummary(middleContents, nextCount);
    logWarn('COMPACTION', 'EMERGENCY_COMPACTION_FALLBACK_SUMMARY', {
      requestId: context.requestId,
      metadata: { conversationId: context.conversationId, compactionCount: nextCount },
    });
  }

  const rewrittenContents = mergeAdjacentContents([
    ...body.contents.slice(0, keepHead),
    buildGeminiSummaryEntry(summary),
    ...body.contents.slice(body.contents.length - keepTail),
  ]);
  const rewrittenBody = {
    ...body,
    contents: rewrittenContents,
  };

  const reducedChars = Math.max(0, originalSize - estimateTextSize(rewrittenBody));
  logInfo('COMPACTION', 'CONTEXT_REDUCED', {
    requestId: context.requestId,
    metadata: {
      conversationId: context.conversationId,
      compactionCount: nextCount,
      reducedChars,
      originalContents,
      compactedContents: rewrittenContents.length,
    },
  });
  logInfo('COMPACTION', 'REQUEST_REWRITTEN', {
    requestId: context.requestId,
    metadata: {
      conversationId: context.conversationId,
      compactionCount: nextCount,
      compactedContents: rewrittenContents.length,
    },
  });

  if (context.conversationId) {
    await persistEmergencyCompactionState({
      conversationId: context.conversationId,
      summary,
      compactionCount: nextCount,
      updatedAt: Date.now(),
    }, context.summaryKey, store);
    logInfo('COMPACTION', 'COMPACTED_STATE_PERSISTED', {
      requestId: context.requestId,
      metadata: { conversationId: context.conversationId, compactionCount: nextCount },
    });
  }

  return {
    body: rewrittenBody,
    compacted: true,
    hardFallback: false,
    compactionCount: nextCount,
    originalContents,
    compactedContents: rewrittenContents.length,
    reducedChars,
    summary,
  };
}