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
            // If signature is lost, we MUST convert to text. 
            // Sending a functionCall without a signature to a reasoning-enabled Gemini model results in a 400.
            // We record this ID so we can also convert the corresponding tool_result to text.
            convertedToolIds.add(block.id);
            parts.push({
              text: `[Action: I am calling tool \`${block.name}\` with arguments: ${JSON.stringify(block.input)}]`
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
          const cachedName = await redis.get(`gemini:toolname:${block.tool_use_id}`);
          let fnName = cachedName ? String(cachedName) : undefined;
          
          if (!fnName) {
            // Fallback: check if we saw this tool ID earlier in the history (populated in this request's loop)
            fnName = toolIdMap.get(block.tool_use_id);
          }
          
          if (!fnName) fnName = 'unknown_tool';
          
          let content = block.content;
          if (!content || (Array.isArray(content) && content.length === 0)) {
            content = { result: "Tool executed (empty result)." };
          } else if (typeof content === 'string') {
            content = { result: content };
          } else if (!Array.isArray(content)) {
            content = Object.keys(content).length > 0 ? content : { result: "Success" };
          } else {
            content = {
              result: content.map((c: any) => {
                if (c.type === 'text') return c.text;
                if (c.type === 'image') return "[image]";
                return JSON.stringify(c);
              }).join("\n")
            };
          }

          parts.push({
            functionResponse: {
              name: fnName,
              response: content,
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
  if (contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: " " }] });
  }

  // ── Generation config ────────────────────────────────────────────────────
  const generationConfig: any = {};

  // max_tokens: clamp to the model's output ceiling so we never send an
  // oversized value that Gemini rejects with a 400.
  if (anthropicReq.max_tokens !== undefined) {
    const requestedMax = Number(anthropicReq.max_tokens);
    const ceiling = internalModel
      ? (MODEL_MAX_OUTPUT_TOKENS[internalModel] ?? DEFAULT_MAX_OUTPUT_TOKENS)
      : DEFAULT_MAX_OUTPUT_TOKENS;
    
    if (requestedMax > 0) {
      generationConfig.maxOutputTokens = Math.min(requestedMax, ceiling);
    }
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
        // Clamp to Gemini-supported range [0, 24576]
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
    result.tools = transformToolsToGemini(anthropicReq.tools);

    // tool_choice → toolConfig — only meaningful when tools are present.
    const toolConfig = buildToolConfig(anthropicReq.tool_choice);
    if (toolConfig) result.toolConfig = toolConfig;
  }

  if (Object.keys(generationConfig).length > 0) result.generationConfig = generationConfig;

  return result;
}
