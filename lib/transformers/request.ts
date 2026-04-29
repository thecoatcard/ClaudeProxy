import { transformToolsToGemini } from './tools';
import { redis } from '../redis';

// Per-model max output token ceilings (Gemini rejects values above these).
const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'gemini-2.5-flash':               65536,
  'gemini-2.5-flash-lite':          32768,
  'gemini-3.1-flash-lite-preview':  131072, // Preview models often have massive ceilings
  'gemini-3-flash-preview':         65536,
  'gemini-flash-latest':            8192,
  'gemini-flash-lite-latest':       8192,
  'gemma-4-31b-it':                 8192,
  'gemma-4-26b-a4b-it':             8192,
};
const DEFAULT_MAX_OUTPUT_TOKENS = 16384; // Increased from 8192

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
        cfg.functionCallingConfig.allowedFunctionNames = [toolChoice.name];
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
  internalModel?: string
) {
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
  
  for (const msg of anthropicReq.messages || []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content || " " });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text || " " });
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
          const sig = await redis.get(`gemini:thought:${block.id}`);
          if (sig) {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input && typeof block.input === 'object' ? block.input : {}
              },
              thoughtSignature: sig
            });
          } else {
            // Cross-model fallback: if signature is lost, convert to text to prevent strict API 400s
            parts.push({
              text: `[Action: I will now call the tool \`${block.name}\` with arguments: ${JSON.stringify(block.input)}]`
            });
          }
        } else if (block.type === 'tool_result') {
          const fnName = toolIdMap.get(block.tool_use_id) || 'unknown_tool';

          // Claude Code sends tool_result.content as string OR as an array of
          // content blocks (text/image). Normalize to a plain string, then
          // wrap in { output } / { error } for Gemini's functionResponse.
          // Any image blocks are forwarded as separate inlineData/fileData parts.
          let outputText = '';
          const imageParts: any[] = [];
          if (typeof block.content === 'string') {
            outputText = block.content;
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .map((c: any) => {
                if (typeof c === 'string') return c;
                if (c?.type === 'text') return c.text || '';
                if (c?.type === 'image') {
                  const src = c.source || {};
                  if (src.type === 'base64' && src.data) {
                    imageParts.push({
                      inlineData: { mimeType: src.media_type || 'image/png', data: src.data },
                    });
                  } else if (src.type === 'url' && src.url) {
                    imageParts.push({
                      fileData: { mimeType: src.media_type || 'image/png', fileUri: src.url },
                    });
                  }
                  return '';
                }
                return '';
              })
              .filter(Boolean)
              .join('\n');
          } else if (block.content != null) {
            try { outputText = JSON.stringify(block.content); } catch(e) { outputText = String(block.content); }
          }

          const responseObj = block.is_error
            ? { error: outputText || 'tool error' }
            : { output: outputText };

          const sig = await redis.get(`gemini:thought:${block.tool_use_id}`);
          if (sig) {
            parts.push({
              functionResponse: {
                name: fnName,
                response: responseObj
              }
            });
          } else {
            // Cross-model fallback: convert response to text
            parts.push({
              text: `[Tool Result for \`${fnName}\`${block.is_error ? ' (error)' : ''}]:\n${outputText}`
            });
          }
          for (const imgPart of imageParts) parts.push(imgPart);
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
  if (contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: " " }] });
  }

  // ── Generation config ────────────────────────────────────────────────────
  const generationConfig: any = {};

  // max_tokens: clamp to the model's output ceiling so we never send an
  // oversized value that Gemini rejects with a 400.
  if (anthropicReq.max_tokens !== undefined) {
    const ceiling = internalModel
      ? (MODEL_MAX_OUTPUT_TOKENS[internalModel] ?? DEFAULT_MAX_OUTPUT_TOKENS)
      : DEFAULT_MAX_OUTPUT_TOKENS;
    generationConfig.maxOutputTokens = Math.min(Number(anthropicReq.max_tokens), ceiling);
  }

  if (anthropicReq.temperature !== undefined) generationConfig.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p       !== undefined) generationConfig.topP        = anthropicReq.top_p;
  // top_k is not in the Anthropic spec but Claude Code occasionally forwards it.
  if (anthropicReq.top_k       !== undefined) generationConfig.topK        = anthropicReq.top_k;

  // stop_sequences → Gemini stopSequences.
  // Claude Code uses stop sequences as flow-control signals.
  if (Array.isArray(anthropicReq.stop_sequences) && anthropicReq.stop_sequences.length > 0) {
    generationConfig.stopSequences = anthropicReq.stop_sequences;
  }

  // Map Anthropic extended thinking → Gemini thinkingConfig.
  // Claude Code sends `thinking: { type: "enabled", budget_tokens: N }`.
  // Flipping `includeThoughts: true` makes Gemini return reasoning as thought
  // parts so we can surface them back as Anthropic thinking blocks.
  // The `interleaved-thinking-2025-05-14` beta allows thinking blocks to appear
  // between tool_use blocks — no extra handling needed here; the stream/response
  // transformers already emit thought parts as thinking content_blocks.

const thinking = anthropicReq.thinking;

if (
  thinking &&
  typeof thinking === "object" &&
  thinking.type === "enabled"
) {
  const GEMINI_MAX_THINKING_BUDGET = 24576;
  const budget = Number(thinking.budget_tokens);

  const thinkingConfig: any = {
    includeThoughts: true,
  };

  if (Number.isFinite(budget)) {
    if (budget < 0) {
      // Let Gemini decide dynamically
      thinkingConfig.thinkingBudget = -1;
    } else {
      // Clamp to Gemini-supported range
      thinkingConfig.thinkingBudget = Math.min(
        Math.max(0, Math.floor(budget)),
        GEMINI_MAX_THINKING_BUDGET
      );
    }
  } else {
    // Invalid/missing budget → dynamic
    thinkingConfig.thinkingBudget = -1;
  }

  generationConfig.thinkingConfig = thinkingConfig;

  // Better default for reasoning workloads
  if (anthropicReq.temperature === undefined) {
    generationConfig.temperature = 0.7;
  }
}

  const result: any = {
    contents,
  };

  if (systemInstruction) result.systemInstruction = systemInstruction;

  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    result.tools = transformToolsToGemini(anthropicReq.tools);

    // tool_choice → toolConfig — only meaningful when tools are present.
    const toolConfig = buildToolConfig(anthropicReq.tool_choice);
    if (toolConfig) result.toolConfig = toolConfig;
  }

  if (Object.keys(generationConfig).length > 0) result.generationConfig = generationConfig;

  return result;
}
