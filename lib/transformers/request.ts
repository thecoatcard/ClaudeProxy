import { transformToolsToGemini } from './tools';
import { redis } from '../redis';

export async function transformRequestToGemini(
  anthropicReq: any,
  toolIdMap: Map<string, string>,
  toolSchemas?: Map<string, any>
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
    systemText = anthropicReq.system.map((s: any) => s.text).join('\n');
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

  // Remove empty configs
  const generationConfig: any = {};
  if (anthropicReq.max_tokens !== undefined) generationConfig.maxOutputTokens = anthropicReq.max_tokens;
  if (anthropicReq.temperature !== undefined) generationConfig.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) generationConfig.topP = anthropicReq.top_p;

  // Map Anthropic extended thinking → Gemini thinkingConfig.
  // Claude Code sends `thinking: { type: "enabled", budget_tokens: N }`.
  // Flipping `includeThoughts: true` makes Gemini return reasoning as thought
  // parts so we can surface them back as Anthropic thinking blocks.
  const thinking = anthropicReq.thinking;
  if (thinking && typeof thinking === 'object' && thinking.type === 'enabled') {
    const budget = Number(thinking.budget_tokens);
    const thinkingConfig: any = { includeThoughts: true };
    if (Number.isFinite(budget) && budget > 0) {
      thinkingConfig.thinkingBudget = Math.floor(budget);
    } else {
      // -1 = dynamic budget; Gemini picks per-request.
      thinkingConfig.thinkingBudget = -1;
    }
    generationConfig.thinkingConfig = thinkingConfig;

    // Reasoning benchmarks favor ~0.7 over Gemini's 1.0 default.
    if (anthropicReq.temperature === undefined) {
      generationConfig.temperature = 0.7;
    }
  }

  const result: any = {
    contents,
  };
  
  if (systemInstruction) result.systemInstruction = systemInstruction;
  if (anthropicReq.tools && anthropicReq.tools.length > 0) result.tools = transformToolsToGemini(anthropicReq.tools);
  if (Object.keys(generationConfig).length > 0) result.generationConfig = generationConfig;

  return result;
}
