import { transformToolsToGemini } from './tools';
import { redis } from '../redis';
import { compactMessagesDetailed } from './compaction';
import { getHealthiestKeyObj } from '../key-manager';
import {
  archiveToolOutput,
  countLargeToolResults,
  ARCHIVE_THRESHOLD_CHARS,
  ARCHIVE_KEEP_RECENT,
} from '../tool-archive';
import { runBehaviorAudit } from '../agent/behavior-auditor';
import { recordToolFailure } from '../tools/tool-failure-memory';
import {
  isEditTool,
  extractFilePath,
  classifyEditFailure,
  normalizeLineEndings,
} from '../tools/edit-failure-classifier';
import { getAdaptiveCompactionPolicy } from './adaptive-compaction-policy';
import { hydrateCompactedMarkers } from '../compactor/ai-compactor';
import { stableHash } from '../utils/hash';
import { partitionWebSearchTools, type WebSearchConfig } from '../tools/web-search';
import {
  loadOperationalState,
  saveOperationalState,
  updateStateFromMessages,
  buildOperationalGuidance,
  operationalStateKey,
  type OperationalStateStore,
} from '../context/operational-state';
import {
  applyCanonicalEmergencyState,
  loadEmergencyCompactionState,
} from '../context/emergency-compactor';
import {
  evaluateHydration,
  evaluateHydrationForEstablishedSession,
  extractWorkspaceRootFromSystem,
  extractWorkspaceRootFromMessages,
  messagesContainCompactedMarker,
  type HydrationVerdict,
} from '../context/hydration-guard';
import { logInfo } from '../logging/event-logger';
import { getOrCreateSessionNonce, deriveHardSessionId, deriveSlotHash } from '../session/session-identity';
import { computeWorkspaceFingerprint } from '../session/workspace-fingerprint';
import { loadSessionBinding, saveSessionBinding, validateBinding } from '../session/session-binding';
export type { WebSearchConfig };

export interface GatewayRequestContext {
  conversationId: string;
  summaryKey: string;
}

// Redis store adapter for operational state.
const opStateStore: OperationalStateStore = {
  async get(key: string) {
    const v = await redis.get<string>(key).catch(() => null);
    return typeof v === 'string' ? v : null;
  },
  async set(key: string, value: string, ttl: number) {
    await redis.set(key, value, { ex: ttl }).catch(() => {});
  },
};

// Per-model max output token ceilings (Gemini rejects values above these).
// Per-model max output token ceilings (Gemini rejects values above these).
// NOTE: The *actual* API limits differ slightly from Google's documentation:
//   - gemini-3-flash-preview API limit = 64,000 (error message confirms this)
//   - gemini-2.5-flash API limit = 65,536 but we use 64,000 for safety margin
// We apply a 512-token safety margin on top of the API limit to avoid
// edge-case rejections from token-counting differences between client and server.
const MAX_OUTPUT_TOKEN_SAFETY_MARGIN = 512;
const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'gemini-2.5-flash':               65536 - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 65024
  'gemini-2.5-flash-lite':          32768 - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 32256
  'gemini-3.1-flash-lite-preview':  65536 - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 65024 (131k is output+thinking combined)
  'gemini-3-flash-preview':         64000 - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 63488 (error-confirmed 64k limit)
  'gemini-flash-latest':            8192  - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 7680
  'gemini-flash-lite-latest':       8192  - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 7680
  'gemma-4-31b-it':                 8192  - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 7680
  'gemma-4-26b-a4b-it':             8192  - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 7680
};
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const SUMMARY_TTL_SECONDS = Number(process.env.CONTEXT_SUMMARY_TTL || 21600); // 6h
const DEFAULT_COMPACTION_TARGET_TOKENS = Number(process.env.CONTEXT_COMPACTION_TARGET_TOKENS || 180000);
const LITE_COMPACTION_TARGET_TOKENS = Number(process.env.CONTEXT_COMPACTION_TARGET_TOKENS_LITE || 120000);
const DEFAULT_SUMMARY_CHAR_BUDGET = Number(process.env.CONTEXT_SUMMARY_CHAR_BUDGET || 3000);
// Max chars of a single tool result before it is truncated.
// Claude Code's Read tool can return 500KB+ files. Without a cap these blow
// the context window in 2-3 turns. Default = ~40k chars ≈ 10k tokens.
// Tail bytes are preserved so file endings (exports, closing braces) remain visible.
const TOOL_RESULT_MAX_CHARS = Number(process.env.TOOL_RESULT_MAX_CHARS || 40000);
const TOOL_RESULT_TAIL_CHARS = Number(process.env.TOOL_RESULT_TAIL_CHARS || 4000);

function extractText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => {
    if (typeof block === 'string') return block;
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (block?.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
    return '';
  }).join('\n');
}

function deriveSummaryKey(anthropicReq: any, userId?: string): string {
  const explicitId = anthropicReq?.metadata?.conversation_id
    || anthropicReq?.conversation_id
    || anthropicReq?.session_id
    || anthropicReq?.thread_id;

  if (typeof explicitId === 'string' && explicitId.trim()) {
    return `context:summary:${explicitId.trim()}`;
  }

  const systemText = typeof anthropicReq?.system === 'string' ? anthropicReq.system : '';
  const firstUser = (anthropicReq?.messages || []).find((msg: any) => msg?.role === 'user');
  const anchor = `${userId || 'anon'}|${systemText.slice(0, 400)}|${extractText(firstUser?.content).slice(0, 400)}`;
  return `context:summary:${stableHash(anchor)}`;
}

/**
 * Phase 1 — Hard Session Identity.
 *
 * Explicit IDs (from request metadata) are returned as-is.
 * Anonymous IDs are returned as a PLACEHOLDER; the caller must
 * call finalizeConversationId() once the nonce and fingerprint are ready.
 * This two-stage approach keeps deriveConversationId synchronous for callers
 * that only need the summaryKey, while allowing transformRequestToGemini to
 * await the async nonce before setting the final conversationId.
 */
function deriveConversationId(anthropicReq: any, userId?: string): string {
  const explicitId = anthropicReq?.metadata?.conversation_id
    || anthropicReq?.conversation_id
    || anthropicReq?.session_id
    || anthropicReq?.thread_id;

  if (typeof explicitId === 'string' && explicitId.trim()) {
    return explicitId.trim();
  }

  // Return the legacy hash-based fallback synchronously.
  // This is used for the summaryKey and as the slot address for the nonce store.
  // The FINAL conversationId will be upgraded by finalizeConversationId().
  const systemText = typeof anthropicReq?.system === 'string' ? anthropicReq.system : '';
  const firstUser = (anthropicReq?.messages || []).find((msg: any) => msg?.role === 'user');
  const anchor = `${userId || 'anon'}|${systemText.slice(0, 400)}|${extractText(firstUser?.content).slice(0, 400)}`;
  return `anon-${stableHash(anchor)}`;
}

/**
 * Phase 1 — Upgrade a legacy hash-derived conversationId to a nonce-based one.
 * If an explicit ID was used, returns it unchanged.
 * Otherwise: slot = stableHash(user|system|firstMsg); nonce = Redis(slot); id = hash(user|fingerprint|nonce).
 */
async function finalizeConversationId(
  anthropicReq: any,
  userId: string,
  legacyId: string,
  workspaceFingerprint: string,
): Promise<string> {
  // Explicit IDs do not need upgrading.
  const explicitId = anthropicReq?.metadata?.conversation_id
    || anthropicReq?.conversation_id
    || anthropicReq?.session_id
    || anthropicReq?.thread_id;
  if (typeof explicitId === 'string' && explicitId.trim()) return explicitId.trim();

  // Derive the slot hash from the legacy anchor.
  const systemText = typeof anthropicReq?.system === 'string' ? anthropicReq.system : '';
  const firstUser = (anthropicReq?.messages || []).find((msg: any) => msg?.role === 'user');
  const slotHash = deriveSlotHash(userId, systemText, extractText(firstUser?.content));

  // Retrieve or create the nonce for this slot.
  const nonce = await getOrCreateSessionNonce(slotHash);

  return deriveHardSessionId(userId, workspaceFingerprint, nonce);
}

function getCompactionTargetTokens(internalModel?: string): number {
  if (!internalModel) return DEFAULT_COMPACTION_TARGET_TOKENS;
  if (internalModel.includes('lite')) return LITE_COMPACTION_TARGET_TOKENS;
  return DEFAULT_COMPACTION_TARGET_TOKENS;
}

/**
 * Build a Gemini toolConfig from an Anthropic tool_choice object.
 *
 *  { type: "auto" }                → AUTO  (default — model decides)
 *  { type: "any" }                 → ANY   (model must call a tool)
 *  { type: "tool", name: "foo" }   → ANY + allowedFunctionNames: ["foo"]
 *  { type: "none" }                → NONE  (model must NOT call any tool)
 *
 * Ref: https://ai.google.dev/gemini-api/docs/function-calling
 */
function buildToolConfig(toolChoice: any): any | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  switch (toolChoice.type) {
    case 'auto':
      return { functionCallingConfig: { mode: 'AUTO' } };
    case 'any':
      return { functionCallingConfig: { mode: 'ANY' } };
    case 'tool': {
      const cfg: any = { functionCallingConfig: { mode: 'ANY' } };
      if (typeof toolChoice.name === 'string' && toolChoice.name) {
        const sanitized = toolChoice.name.replace(/[^a-zA-Z0-9_]/g, '_');
        cfg.functionCallingConfig.allowedFunctionNames = [sanitized];
      }
      return cfg;
    }
    case 'none':
      return { functionCallingConfig: { mode: 'NONE' } };
    default:
      return undefined;
  }
}

export async function transformRequestToGemini(
  anthropicReq: any,
  toolIdMap: Map<string, string>,
  toolSchemas?: Map<string, any>,
  /** Internal model name resolved by model-router — used for max_token clamping */
  internalModel?: string,
  originalToolNames?: Map<string, string>,
  userId?: string,
  requestId?: string,
): Promise<{ geminiBody: any; webSearchConfig: WebSearchConfig | null; requestContext: GatewayRequestContext }> {
  const rawSystemForExtraction = typeof anthropicReq.system === 'string'
    ? anthropicReq.system
    : Array.isArray(anthropicReq.system)
      ? anthropicReq.system.map((s: any) => (typeof s?.text === 'string' ? s.text : '')).join(' ')
      : '';

  // Phase 2: Workspace fingerprint (stable hex hash of normalised cwd/workspacePath).
  const workspaceFp = computeWorkspaceFingerprint(rawSystemForExtraction, anthropicReq.messages || []);

  // Phase 1: Hard session identity — upgrade the anonymous conversationId to use
  // a nonce instead of the first-message content. The summaryKey still uses the
  // legacy anchor (for backwards compatibility with stored summaries).
  const summaryKey = deriveSummaryKey(anthropicReq, userId);
  const legacyId = deriveConversationId(anthropicReq, userId);
  const conversationId = await finalizeConversationId(
    anthropicReq,
    userId || 'anon',
    legacyId,
    workspaceFp.fingerprint,
  );

  const hasExplicitConversationId = !!(
    anthropicReq?.metadata?.conversation_id ||
    anthropicReq?.conversation_id ||
    anthropicReq?.session_id ||
    anthropicReq?.thread_id
  );
  const requestContext: GatewayRequestContext = { conversationId, summaryKey };
  const baseKeepLastN = Number(process.env.CONTEXT_COMPACTION_KEEP_LAST || 20);
  const compactionPolicy = getAdaptiveCompactionPolicy(
    internalModel,
    getCompactionTargetTokens(internalModel),
    baseKeepLastN,
    DEFAULT_SUMMARY_CHAR_BUDGET,
  );

  // Extract workspace root from the current system prompt for hydration gating.
  // Claude Code primarily injects workspace in user messages (<environment_details>),
  // not in the system prompt, so we check both sources.
  const currentWorkspaceRoot =
    extractWorkspaceRootFromSystem(rawSystemForExtraction) ||
    extractWorkspaceRootFromMessages(anthropicReq.messages || []);

  // Companion Redis key: stores the most-recently-seen workspace root for this
  // conversationId. This is more reliable than op-state.workspace_root because
  // it is explicitly set every request and doesn't depend on tool-call analysis.
  const workspaceRootKey = `context:workspace:${conversationId}`;

  if (Array.isArray(anthropicReq.messages)) {
    // ── Hydration gate ───────────────────────────────────────────────────────
    const hasEstablishedMarkers = messagesContainCompactedMarker(anthropicReq.messages);

    // Load stored workspace root + Phase 4 session binding in parallel.
    let storedWorkspaceRoot: string | null = null;
    let sessionBinding = null;
    try {
      const [companionRoot, rawOpState, binding] = await Promise.all([
        redis.get<string>(workspaceRootKey).catch(() => null),
        opStateStore.get(operationalStateKey(conversationId)).catch(() => null),
        loadSessionBinding(conversationId).catch(() => null),
      ]);
      storedWorkspaceRoot = companionRoot
        ?? (rawOpState ? (JSON.parse(rawOpState)?.workspace_root ?? null) : null);
      sessionBinding = binding;
    } catch { /* best-effort */ }

    // Phase 4: Validate session binding.
    const bindingStatus = validateBinding(sessionBinding, userId || 'anon', workspaceFp.fingerprint);

    const hydrationCtx = {
      messages: anthropicReq.messages,
      conversationId,
      currentWorkspaceRoot,
      storedWorkspaceRoot,
      hasExplicitConversationId,
      currentWorkspaceFingerprint: workspaceFp.fingerprint,
      sessionBindingStatus: bindingStatus,
    };
    const hydrationVerdict: HydrationVerdict = hasEstablishedMarkers
      ? evaluateHydrationForEstablishedSession(hydrationCtx)
      : evaluateHydration(hydrationCtx);

    // Phase 5: CRITICAL Redis write — stale key deletion must be awaited so
    // the next request doesn't read partially-deleted state.
    if (
      hydrationVerdict.reason === 'HYDRATION_SKIPPED_FRESH_SESSION' ||
      hydrationVerdict.reason === 'HYDRATION_SKIPPED_NULL_WORKSPACE' ||
      (hydrationVerdict.reason === 'HYDRATION_SKIPPED_CLEAR_RESET' && anthropicReq.messages.length <= 2)
    ) {
      const staleKeys = [
        summaryKey,
        operationalStateKey(conversationId),
        `context:emergency:${conversationId}`,
        `context:workspace:${conversationId}`,
      ];
      // Phase 5: await this critical write (was fire-and-forget).
      await redis.del(...staleKeys).catch(() => {});
      logInfo('RETRIEVAL', 'Stale session keys deleted', {
        requestId,
        metadata: { conversationId, deletedKeys: staleKeys.length, reason: hydrationVerdict.reason },
      });
    }

    // Phase 4: Save session binding for new sessions (CRITICAL write — await).
    if (bindingStatus === 'new') {
      await saveSessionBinding(conversationId, userId || 'anon', workspaceFp.fingerprint, legacyId).catch(() => {});
    }

    logInfo('RETRIEVAL', `Hydration verdict: ${hydrationVerdict.reason}`, {
      requestId,
      metadata: {
        conversationId,
        allow: hydrationVerdict.allow,
        reason: hydrationVerdict.reason,
        hasEstablishedMarkers,
        messageCount: anthropicReq.messages.length,
        currentWorkspaceRoot: currentWorkspaceRoot ?? null,
        storedWorkspaceRoot,
        workspaceFingerprint: workspaceFp.fingerprint,
        workspaceConfidence: workspaceFp.confidence,
        bindingStatus,
      },
    });

    // Start rolling summary + API key fetch NOW, before the sequential
    // emergency-state load and marker hydration that follow.
    // Hiding this ~50 ms Redis RTT behind other mandatory work cuts cold-start
    // P95 latency for established sessions.
    const contextLookupStart = Date.now();
    const rollingSummaryAndKeyPromise = Promise.all([
      hydrationVerdict.allow ? redis.get<string>(summaryKey).catch(() => '') : Promise.resolve(''),
      getHealthiestKeyObj(userId),
    ]);

    const emergencyState = hydrationVerdict.allow
      ? await loadEmergencyCompactionState(conversationId).catch(() => null)
      : null;
    if (emergencyState) {
      anthropicReq.messages = applyCanonicalEmergencyState(anthropicReq.messages, emergencyState);
      logInfo('COMPACTION', 'REQUEST_REWRITTEN', {
        requestId,
        metadata: {
          conversationId,
          source: 'emergency-state',
          compactionCount: emergencyState.compactionCount,
          messageCount: anthropicReq.messages.length,
        },
      });
    }

    const hydrateStart = Date.now();
    // Only hydrate compacted markers when the guard approved hydration.
    if (hydrationVerdict.allow) {
      anthropicReq.messages = await hydrateCompactedMarkers(anthropicReq.messages, conversationId).catch(() => anthropicReq.messages);
    }
    logInfo('RETRIEVAL', 'Compacted marker hydration completed', {
      requestId,
      duration: Date.now() - hydrateStart,
      metadata: { conversationId, messageCount: anthropicReq.messages.length, skipped: !hydrationVerdict.allow },
    });

    // Await the parallel fetch started above.
    const [rollingSummaryRaw, systemKey] = await rollingSummaryAndKeyPromise;
    const rollingSummary = hydrationVerdict.allow ? rollingSummaryRaw : '';
    logInfo('RETRIEVAL', 'Context metadata lookup completed', {
      requestId,
      duration: Date.now() - contextLookupStart,
      metadata: { hasRollingSummary: Boolean(rollingSummary), hasCompactionKey: Boolean(systemKey?.key), hydrationAllowed: hydrationVerdict.allow },
    });

    const compactionStart = Date.now();
    const compaction = await compactMessagesDetailed(anthropicReq.messages, {
      maxTokensApprox: compactionPolicy.maxTokensApprox,
      maxMessages: Number(process.env.CONTEXT_COMPACTION_MAX_MESSAGES || 60),
      keepFirstN: Number(process.env.CONTEXT_COMPACTION_KEEP_FIRST || 2),
      keepLastN: compactionPolicy.keepLastN,
      rollingSummary: typeof rollingSummary === 'string' ? rollingSummary : '',
      summaryCharBudget: compactionPolicy.summaryCharBudget,
      failureAnchorDepth: compactionPolicy.failureAnchorDepth,
      apiKey: systemKey?.key,
      model: 'gemma-4-26b-a4b-it',  // Compaction model: smaller Gemma (efficient summarization)
      conversationId,
      compactedRangeTtlSeconds: SUMMARY_TTL_SECONDS,
    });
    logInfo('COMPACTION', 'Context compaction evaluated', {
      requestId,
      duration: Date.now() - compactionStart,
      metadata: {
        didCompact: compaction.didCompact,
        originalMessageCount: compaction.originalMessageCount,
        compactedMessageCount: compaction.compactedMessageCount,
        estimatedTokensBefore: compaction.estimatedTokensBefore,
        estimatedTokensAfter: compaction.estimatedTokensAfter,
      },
    });
    anthropicReq.messages = compaction.messages;

    if (compaction.didCompact && compaction.generatedSummary) {
      await redis.set(summaryKey, compaction.generatedSummary, { ex: SUMMARY_TTL_SECONDS }).catch(() => {});
    }

    // Save companion workspace root key so future requests for this conversationId
    // can detect cross-workspace context leakage even when the op-state root is null.
    if (currentWorkspaceRoot) {
      redis.set(workspaceRootKey, currentWorkspaceRoot, { ex: SUMMARY_TTL_SECONDS }).catch(() => {});
    }
  }

  // Capture original Anthropic input_schemas so the response/stream path can
  // repair Gemini functionCall args against them before emitting tool_use.
  // Partition web_search server tools away from regular function tools so they
  // are never sent to Gemini as FunctionDeclarations.
  let webSearchConfig: WebSearchConfig | null = null;
  if (Array.isArray(anthropicReq.tools)) {
    const { webSearchConfig: wsc, functionTools } = partitionWebSearchTools(anthropicReq.tools);
    webSearchConfig = wsc;
    // Replace the tools array with only function tools for downstream processing.
    anthropicReq = { ...anthropicReq, tools: functionTools };
  }

  if (toolSchemas && Array.isArray(anthropicReq.tools)) {
    for (const tool of anthropicReq.tools) {
      if (tool && typeof tool.name === 'string' && tool.input_schema) {
        toolSchemas.set(tool.name, tool.input_schema);
      }
    }
  }

  let systemText = "";
  if (typeof anthropicReq.system === 'string') {
    systemText = anthropicReq.system;
  } else if (Array.isArray(anthropicReq.system)) {
    systemText = anthropicReq.system
      .map((s: any) => {
        if (typeof s === 'string') return s;
        if (s?.type === 'text' && typeof s.text === 'string') return s.text;
        if (typeof s?.text === 'string') return s.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  // ── Failure-loop detection ───────────────────────────────────────────────
  // ── Behavior auditor ────────────────────────────────────────────────────
  // Runs all agent-behavior checks: loop detection, completion gate, path
  // guard, spec validator. Appends combined guidance to systemInstruction.
  const auditStart = Date.now();
  const auditResult = await runBehaviorAudit(anthropicReq.messages || [], systemText, internalModel);
  logInfo('SYSTEM', 'Behavior audit completed', {
    requestId,
    duration: Date.now() - auditStart,
    metadata: auditResult.diagnostics,
  });
  if (auditResult.hasGuidance) {
    systemText = (systemText ? systemText + '\n' : '') + auditResult.guidance;
  }

  // ── Phase 6: Tool failure memory ─────────────────────────────────────────
  // Persist edit failures to Redis so the next request knows how many
  // times an identical edit has failed. Fire-and-forget (noncritical).
  // We look only at the most recent user message for fresh tool_result failures.
  {
    const lastUserMsg = [...(anthropicReq.messages || [])].reverse().find(m => m.role === 'user');
    if (lastUserMsg && Array.isArray(lastUserMsg.content)) {
      const toolUseMap = new Map<string, { name: string; input: Record<string, any> }>();
      // Build map of tool_use.id → name+input from assistant turns
      for (const msg of anthropicReq.messages || []) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === 'tool_use' && block.id) {
              toolUseMap.set(block.id, { name: String(block.name || ''), input: block.input ?? {} });
            }
          }
        }
      }
      for (const block of lastUserMsg.content) {
        if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
        const isError = block.is_error === true;
        const text = typeof block.content === 'string'
          ? normalizeLineEndings(block.content)
          : Array.isArray(block.content)
            ? block.content.map((c: any) => c?.text ?? '').join('\n')
            : '';
        if (!isError && !text) continue;
        const toolUse = toolUseMap.get(block.tool_use_id);
        if (!toolUse || !isEditTool(toolUse.name)) continue;
        const filePath = extractFilePath(toolUse.input);
        const classification = classifyEditFailure(text);
        // Fire-and-forget — Phase 6 failure memory recording
        recordToolFailure(conversationId, toolUse.name, filePath, classification.type).catch(() => {});
      }
    }
  }

  // ── Operational context memory ───────────────────────────────────────────
  // Load persistent operational state (shell type, artifact map, failure
  // memory) from Redis, update it with the current messages, then inject
  // a compact guidance block and save the updated state back.
  // Runs best-effort — a Redis failure never blocks the request.
  //
  // Hydration guard: operational state is only injected when the guard
  // approved hydration for this request. The state is always updated and
  // saved regardless — we only skip the systemInstruction injection.
  let opStateInjected = false;
  const operationalStart = Date.now();
  try {
    const opState = await loadOperationalState(conversationId, opStateStore);
    const updatedOpState = updateStateFromMessages(opState, anthropicReq.messages || []);

    // Re-run workspace boundary check against the just-loaded state.
    const opHydrationVerdict = evaluateHydration({
      messages: anthropicReq.messages || [],
      conversationId,
      currentWorkspaceRoot,
      storedWorkspaceRoot: updatedOpState.workspace_root ?? null,
    });

    if (opHydrationVerdict.allow) {
      const opGuidance = buildOperationalGuidance(updatedOpState);
      if (opGuidance) {
        systemText = (systemText ? systemText + '\n' : '') + opGuidance;
        opStateInjected = true;
      }
    } else {
      logInfo('MEMORY', `Operational state injection blocked: ${opHydrationVerdict.reason}`, {
        requestId,
        metadata: { conversationId, reason: opHydrationVerdict.reason },
      });
    }
    // Always persist updated state — even if we didn't inject, the state
    // accumulates new signals for future requests.
    saveOperationalState(updatedOpState, opStateStore).catch(() => {});
  } catch (e) {
    console.warn('[request] operational state error (non-fatal):', String(e));
  } finally {
    logInfo('MEMORY', 'Operational memory evaluated', {
      requestId,
      duration: Date.now() - operationalStart,
      metadata: { injected: opStateInjected },
    });
  }

  const systemInstruction = systemText ? {
    parts: [{ text: systemText }]
  } : undefined;

  const contents: any[] = [];

  // --- Optimization: Vectorized Metadata Lookup ---
  // Scan history to collect all tool IDs. We'll fetch all signatures and 
  // tool names in one round-trip (mget) to avoid 25s timeouts on long threads.
  const allToolIds = new Set<string>();
  for (const msg of anthropicReq.messages || []) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') allToolIds.add(block.id);
        if (block.type === 'tool_result') allToolIds.add(block.tool_use_id);
      }
    }
  }

  const idList = Array.from(allToolIds);
  const metadataLookupStart = Date.now();
  const [sigs, names] = idList.length > 0 ? await Promise.all([
    redis.mget<string[]>(idList.map(id => `gemini:thought:${id}`)),
    redis.mget<string[]>(idList.map(id => `gemini:toolname:${id}`))
  ]) : [[], []];
  logInfo('MEMORY', 'Tool metadata lookup completed', {
    requestId,
    duration: Date.now() - metadataLookupStart,
    metadata: { toolIds: idList.length },
  });

  const sigMap = new Map<string, string>();
  const nameMap = new Map<string, string>();
  idList.forEach((id, i) => {
    if (sigs[i]) sigMap.set(id, sigs[i]);
    if (names[i]) nameMap.set(id, names[i]);
  });
  // ------------------------------------------------

  // ── Tool Archive: pre-count large results (post-compaction) ──────────────
  // We keep the most recent ARCHIVE_KEEP_RECENT large results in full and
  // archive everything older. Count runs on the already-compacted messages
  // so we only count from the live context, not removed/summarized turns.
  const totalLargeResults = userId
    ? countLargeToolResults(anthropicReq.messages || [])
    : 0;
  let largeResultSeen = 0; // incremented per large result in the loop below
  // ─────────────────────────────────────────────────────────────────────────

  for (const msg of anthropicReq.messages || []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content || " " });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text?.trim()) {
          parts.push({ text: block.text });
        } else if (block.type === 'image') {
          const src = block.source || {};
          if (src.type === 'base64' && src.data) {
            parts.push({
              inlineData: {
                mimeType: src.media_type || 'image/png',
                data: src.data,
              },
            });
          } else if (src.type === 'url' && src.url) {
            parts.push({
              fileData: {
                mimeType: src.media_type || 'image/png',
                fileUri: src.url,
              },
            });
          }
        } else if (block.type === 'thinking') {
          parts.push({ text: `<thought>\n${block.thinking}\n</thought>` });
        } else if (block.type === 'redacted_thinking') {
          parts.push({ text: `<thought>\n[Redacted internal thinking]\n</thought>` });
        } else if (block.type === 'tool_use') {
          toolIdMap.set(block.id, block.name);
          const sig = sigMap.get(block.id);
          // Gemini's functionCall.name MUST use the sanitized name that matches
          // the function declaration. MCP tools with hyphens (my-server__my-tool)
          // become (my_server__my_tool) — using the original name here causes a 400.
          const geminiToolName = block.name.replace(/[^a-zA-Z0-9_]/g, '_');
          const functionCallPart: any = {
            functionCall: {
              name: geminiToolName,
              args: block.input && typeof block.input === 'object' ? block.input : {}
            }
          };
          // Prefer structured calls always. If the signature is missing, retry-engine
          // can degrade thinking/fallback strategy; demoting to plain text leaks action text.
          if (sig) functionCallPart.thoughtSignature = sig;
          parts.push(functionCallPart);
        } else if (block.type === 'tool_result') {
          // Look up the actual function name.
          let fnName = nameMap.get(block.tool_use_id);
          
          if (!fnName) {
            // Fallback: check if we saw this tool ID earlier in the history (populated in this request's loop)
            fnName = toolIdMap.get(block.tool_use_id);
          }
          
          if (!fnName) fnName = 'unknown_tool';
          
          let resultText = "";
          const content = block.content;

          if (!content || (Array.isArray(content) && content.length === 0)) {
            resultText = "Tool executed (empty result).";
          } else if (typeof content === 'string') {
            resultText = content;
          } else if (!Array.isArray(content)) {
            resultText = Object.keys(content).length > 0 ? JSON.stringify(content) : "Success";
          } else {
            // Merge multiple content blocks (text, tool_result parts) into one string for Gemini
            resultText = content.map((c: any) => {
              if (c.type === 'text') return c.text;
              if (c.type === 'image') return "[image omitted]";
              return JSON.stringify(c);
            }).join("\n");
          }

          // ── Tool Output Archive ──────────────────────────────────────────
          // For large results from older turns: replace with a compact reference
          // and store the bytes in Redis. This keeps the live context small.
          // The most recent ARCHIVE_KEEP_RECENT large results are always shown in full
          // so the model can immediately act on its latest tool call outputs.
          if (resultText.length > ARCHIVE_THRESHOLD_CHARS) {
            largeResultSeen++;
            const isOldResult = largeResultSeen <= totalLargeResults - ARCHIVE_KEEP_RECENT;
            if (isOldResult && userId) {
              const originalToolName = toolIdMap.get(block.tool_use_id) || fnName || 'tool';
              const ref = await archiveToolOutput(summaryKey, originalToolName, resultText);
              if (ref) {
                // Successfully archived — swap the full content for the reference tag.
                resultText = ref;
              }
              // If archiving failed, fall through to truncation below.
            }
          }
          // ────────────────────────────────────────────────────────────────

          // Cap large tool outputs (e.g. Read returning a 500KB file, Bash with huge output).
          // We keep the head AND tail so both the start and end of files remain visible
          // (critical for seeing imports at top and exports/closing braces at bottom).
          if (resultText.length > TOOL_RESULT_MAX_CHARS) {
            const headChars = TOOL_RESULT_MAX_CHARS - TOOL_RESULT_TAIL_CHARS;
            const head = resultText.slice(0, headChars);
            const tail = resultText.slice(-TOOL_RESULT_TAIL_CHARS);
            resultText = (
              head +
              `\n\n... [GATEWAY: truncated ${resultText.length - TOOL_RESULT_MAX_CHARS} chars] ...\n\n` +
              tail
            );
          }

          const isFailure = block.is_error === true;

          parts.push({
            functionResponse: {
              name: fnName,
              response: isFailure
                ? { ok: false, error: resultText }
                : { ok: true, result: resultText },
            },
          });
        }
      }
    }

    if (parts.length > 0) {
      const lastMsg = contents[contents.length - 1];
      if (lastMsg && lastMsg.role === role) {
        lastMsg.parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    }
  }

  // Ensure history ends with a user message (Gemini requirement for generation)
  if (contents.length > 0 && contents[contents.length - 1].role === 'model') {
    contents.push({ role: 'user', parts: [{ text: "Continue" }] });
  }

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: " " }] });
  }

  // Gemini requires history to start with a user turn.
  if (contents.length > 0 && contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: " " }] });
  }

  // ── Generation config ────────────────────────────────────────────────────
  const generationConfig: any = {};

  // max_tokens: clamp to the model's output ceiling so we never send an
  // oversized value that Gemini rejects with a 400.
  const ceiling = internalModel
    ? (MODEL_MAX_OUTPUT_TOKENS[internalModel] ?? DEFAULT_MAX_OUTPUT_TOKENS)
    : DEFAULT_MAX_OUTPUT_TOKENS;

  if (anthropicReq.max_tokens !== undefined) {
    const requestedMax = Number(anthropicReq.max_tokens);
    if (requestedMax > 0) {
      generationConfig.maxOutputTokens = Math.min(requestedMax, ceiling);
    }
  } else {
    // Set a sensible default if not provided (prevents premature truncation)
    generationConfig.maxOutputTokens = Math.min(8192, ceiling);
  }

  if (anthropicReq.temperature !== undefined) generationConfig.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p       !== undefined) generationConfig.topP        = anthropicReq.top_p;
  // top_k is not in the Anthropic spec but Claude Code occasionally forwards it.
  // BUG-008 FIX: Gemini 2.5 supports topK up to 64; cap per-model rather than
  // using a blanket 40 limit that silently truncates valid values for newer models.
  if (anthropicReq.top_k !== undefined) {
    const TOP_K_CEILING = (internalModel && (
      internalModel.includes('2.5') || internalModel.includes('3.') 
    )) ? 64 : 40;
    generationConfig.topK = Math.min(Number(anthropicReq.top_k), TOP_K_CEILING);
  }

  // stop_sequences → Gemini stopSequences.
  // Claude Code uses stop sequences as flow-control signals.
  if (Array.isArray(anthropicReq.stop_sequences) && anthropicReq.stop_sequences.length > 0) {
    generationConfig.stopSequences = anthropicReq.stop_sequences.slice(0, 5);
  }

  // Map Anthropic extended thinking → Gemini thinkingConfig.
  // Claude Code sends `thinking: { type: "enabled", budget_tokens: N }`.
  // Flipping `includeThoughts: true` makes Gemini return reasoning as thought
  // parts so we can surface them back as Anthropic thinking blocks.
  const thinking = anthropicReq.thinking;

  if (
    thinking &&
    typeof thinking === "object" &&
    thinking.type === "enabled"
  ) {
    // Gemini 2.0 Flash/Pro supports up to 24k thinking budget.
    // Claude 3.7 Sonnet supports up to 128k (but we must clamp to Gemini's limit).
    const GEMINI_MAX_THINKING_BUDGET = 24576;
    const budget = Number(thinking.budget_tokens);

    const thinkingConfig: any = {
      includeThoughts: true,
    };

    if (Number.isFinite(budget)) {
      if (budget < 0) {
        // Let Gemini decide dynamically if -1 or invalid
        thinkingConfig.thinkingBudget = -1;
      } else {
        // Clamp to Gemini-supported range [0, 24576] AND ensured it doesn't exceed 
        // the total maxOutputTokens (otherwise Gemini returns a 400).
        const maxTotal = generationConfig.maxOutputTokens || ceiling;
        thinkingConfig.thinkingBudget = Math.min(
          Math.max(0, Math.floor(budget)),
          GEMINI_MAX_THINKING_BUDGET,
          Math.max(0, maxTotal - 1024) // Leave 1k tokens for the actual text response
        );
      }
    } else {
      // Invalid/missing budget → dynamic
      thinkingConfig.thinkingBudget = -1;
    }
    // Explicit set of models known to support thinkingConfig.
    // gemini-3-flash-preview is our primary reasoning/high-capability model
    // and MUST be included — substring checks like '3.1' or '3.5' would miss it.
    const THINKING_CAPABLE_MODELS = new Set([
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3.1-flash-lite-preview',
      'gemini-3-flash-preview',
      'gemini-flash-latest',      // alias — tracks stable flash which supports thinking
    ]);
    const supportsThinking = !!internalModel && THINKING_CAPABLE_MODELS.has(internalModel);

    if (supportsThinking) {
      generationConfig.thinkingConfig = thinkingConfig;
    }

    // Claude 3.7 Sonnet defaults to temp 1.0 when thinking is enabled, 
    // but Gemini performs better at 0.7 for reasoning tasks.
    if (anthropicReq.temperature === undefined) {
      generationConfig.temperature = 0.7;
    }
  }

  const result: any = {
    contents,
  };

  if (systemInstruction) result.systemInstruction = systemInstruction;

  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    result.tools = transformToolsToGemini(anthropicReq.tools, originalToolNames);

    // tool_choice → toolConfig — only meaningful when tools are present.
    const toolConfig = buildToolConfig(anthropicReq.tool_choice);
    if (toolConfig) result.toolConfig = toolConfig;
  }

  if (Object.keys(generationConfig).length > 0) result.generationConfig = generationConfig;
  
  // Add permissive safety settings to avoid blocking technical/coding content.
  result.safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
  ];

  return { geminiBody: result, webSearchConfig, requestContext };
}
