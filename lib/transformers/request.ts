import { transformToolsToGemini } from './tools';
import { redis } from '../redis';

export async function transformRequestToGemini(anthropicReq: any, toolIdMap: Map<string, string>) {
  let systemText = "";
  if (typeof anthropicReq.system === 'string') {
    systemText = anthropicReq.system;
  } else if (Array.isArray(anthropicReq.system)) {
    systemText = anthropicReq.system.map((s: any) => s.text).join('\n');
  }

  const systemInstruction = systemText ? {
    parts: [{ text: systemText }]
  } : undefined;

  const contents = [];
  
  for (const msg of anthropicReq.messages || []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content || " " });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text || " " });
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
                args: block.input
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
          let outputObj = block.content;
          if (typeof outputObj === 'string') {
             try { outputObj = JSON.parse(outputObj); } catch(e) {}
          }
          
          const sig = await redis.get(`gemini:thought:${block.tool_use_id}`);
          if (sig) {
            parts.push({
              functionResponse: {
                name: fnName,
                response: { output: outputObj }
              }
            });
          } else {
            // Cross-model fallback: convert response to text
            parts.push({
              text: `[Tool Result for \`${fnName}\`]:\n${typeof outputObj === 'string' ? outputObj : JSON.stringify(outputObj)}`
            });
          }
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: " " }] });
  }

  // Remove empty configs
  const generationConfig: any = {};
  if (anthropicReq.max_tokens !== undefined) generationConfig.maxOutputTokens = anthropicReq.max_tokens;
  if (anthropicReq.temperature !== undefined) generationConfig.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) generationConfig.topP = anthropicReq.top_p;

  const result: any = {
    contents,
  };
  
  if (systemInstruction) result.systemInstruction = systemInstruction;
  if (anthropicReq.tools && anthropicReq.tools.length > 0) result.tools = transformToolsToGemini(anthropicReq.tools);
  if (Object.keys(generationConfig).length > 0) result.generationConfig = generationConfig;

  return result;
}
