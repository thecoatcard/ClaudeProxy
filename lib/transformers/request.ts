import { transformToolsToGemini } from './tools';
import { redis } from '../redis';
import { compactMessagesAsync } from './compaction';
import { getHealthiestKeyObj } from '../key-manager';
import {
  archiveToolOutput,
  countLargeToolResults,
  ARCHIVE_THRESHOLD_CHARS,
  ARCHIVE_KEEP_RECENT,
} from '../tool-archive';

// Per-model max output token ceilings (Gemini rejects values above these).
// Per-model max output token ceilings (Gemini rejects values above these).
// NOTE: The *actual* API limits differ slightly from Google's documentation:
//   - gemini-3-flash-preview API limit = 64,000 (error message confirms this)
//   - gemini-2.5-flash API limit = 65,536 but we use 64,000 for safety margin
// We apply a 512-token safety margin on top of the API limit to avoid
// edge-case rejections from token-counting differences between client and server.
const MAX_OUTPUT_TOKEN_SAFETY_MARGIN = 512;
const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'gemini-2.5-flash':               64000 - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 63488 (64k confirmed by API error)
  'gemini-2.5-flash-lite':          32768 - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 32256
  'gemini-3.1-flash-lite-preview':  64000 - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 63488 (64k limit; 131k is combined output+thinking budget)
  'gemini-3-flash-preview':         64000 - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 63488 (error-confirmed 64k limit)
  'gemini-flash-latest':            8192  - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 7680
  'gemini-flash-lite-latest':       8192  - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 7680
  'gemma-4-31b-it':                 8192  - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 7680
  'gemma-4-26b-a4b-it':             8192  - MAX_OUTPUT_TOKEN_SAFETY_MARGIN, // = 7680
};
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const SUMMARY_TTL_SECONDS = Number(process.env.CONTEXT_SUMMARY_TTL || 21600); // 6h
const DEFAULT_COMPACTION_TARGET_TOKENS = Number(process.env.CONTEXT_COMPACTION_TARGET_TOKENS || 90000);
const LITE_COMPACTION_TARGET_TOKENS = Number(process.env.CONTEXT_COMPACTION_TARGET_TOKENS_LITE || 65000);
// Max chars of a single tool result before it is truncated.
// Claude Code's Read tool can return 500KB+ files. Without a cap these blow
// the context window in 2-3 turns. Default = ~40k chars ≈ 10k tokens.
// Tail bytes are preserved so file endings (exports, closing braces) remain visible.
const TOOL_RESULT_MAX_CHARS = Number(process.env.TOOL_RESULT_MAX_CHARS || 40000);
const TOOL_RESULT_TAIL_CHARS = Number(process.env.TOOL_RESULT_TAIL_CHARS || 4000);

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

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
  userId?: string
) {
  // Derive session key once — used by compaction, rolling summary AND tool archive.
  const summaryKey = deriveSummaryKey(anthropicReq, userId);

  if (Array.isArray(anthropicReq.messages)) {
    // Pipeline initial metadata lookups to save RTT
    const [rollingSummary, systemKey] = await Promise.all([
      redis.get<string>(summaryKey).catch(() => ''),
      getHealthiestKeyObj(userId)
    ]);

    const compaction = await compactMessagesAsync(anthropicReq.messages, {
      maxTokensApprox: getCompactionTargetTokens(internalModel),
      maxMessages: Number(process.env.CONTEXT_COMPACTION_MAX_MESSAGES || 60),
      keepFirstN: Number(process.env.CONTEXT_COMPACTION_KEEP_FIRST || 2),
      keepLastN: Number(process.env.CONTEXT_COMPACTION_KEEP_LAST || 20),
      rollingSummary: typeof rollingSummary === 'string' ? rollingSummary : '',
      apiKey: systemKey?.key,
      model: 'gemma-4-31b-it',
    });
    anthropicReq.messages = compaction.messages;

    // Persist the rolling summary only when compaction produced a fresh summary.
    // If the cache was hit, the Redis value is already the authoritative AI
    // summary — no need to overwrite it with a stale heuristic version.
    if (compaction.didCompact && compaction.generatedSummary) {
      await redis.set(summaryKey, compaction.generatedSummary, { ex: SUMMARY_TTL_SECONDS }).catch(() => {});
    }
  }

  const convertedToolIds = new Set<string>();
  // Capture original Anthropic input_schemas so the response/stream path can
  // repair Gemini functionCall args against them before emitting tool_use.
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
  const [sigs, names] = idList.length > 0 ? await Promise.all([
    redis.mget<string[]>(idList.map(id => `gemini:thought:${id}`)),
    redis.mget<string[]>(idList.map(id => `gemini:toolname:${id}`))
  ]) : [[], []];

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
          if (sig) {
            parts.push({
              functionCall: {
                name: geminiToolName,
                args: block.input && typeof block.input === 'object' ? block.input : {}
              },
              thoughtSignature: sig
            });
          } else {
            // If signature is lost, we MUST convert to text. 
            // Sending a functionCall without a signature to a reasoning-enabled Gemini model results in a 400.
            convertedToolIds.add(block.id);
            parts.push({
              text: `[Action: I am calling tool \`${geminiToolName}\` with arguments: ${JSON.stringify(block.input)}]`
            });
          }
        } else if (block.type === 'tool_result') {
          if (convertedToolIds.has(block.tool_use_id)) {
            // Corresponding tool_use was converted to text, so this must be text too.
            let resultText = "";
            if (typeof block.content === 'string') {
              resultText = block.content;
            } else if (Array.isArray(block.content)) {
              resultText = block.content.map((c: any) => c.text || JSON.stringify(c)).join("\n");
            } else {
              resultText = JSON.stringify(block.content);
            }
            parts.push({ text: `[Tool Result]:\n${resultText}` });
            continue;
          }

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

          parts.push({
            functionResponse: {
              name: fnName,
              response: { result: resultText },
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
  // Gemini's topK is usually capped at 40.
  if (anthropicReq.top_k       !== undefined) {
    generationConfig.topK = Math.min(Number(anthropicReq.top_k), 40);
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

  return result;
}
