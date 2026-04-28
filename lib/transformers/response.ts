import { mapStopReason } from './stop-reason';
import { nanoid } from 'nanoid';
import { redis } from '../redis';

export async function transformGeminiToAnthropic(geminiRes: any, reqModel: string, toolIdMap: Map<string, string>) {
  const candidate = geminiRes.candidates?.[0];
  if (!candidate) {
    throw new Error('No candidate returned from Gemini');
  }

  const contentBlocks = [];
  
  for (const part of candidate.content?.parts || []) {
    if (part.text) {
      let cleanedText = part.text.replace(/<(think|thought)>[\s\S]*?(<\/(think|thought)>|$)/gi, '');
      if (cleanedText) {
        contentBlocks.push({
          type: 'text',
          text: cleanedText
        });
      }
    } else if (part.functionCall) {
      const toolId = 'toolu_' + nanoid(24);
      toolIdMap.set(toolId, part.functionCall.name);
      
      if (part.thoughtSignature) {
        await redis.setex(`gemini:thought:${toolId}`, 3600, part.thoughtSignature);
      }

      contentBlocks.push({
        type: 'tool_use',
        id: toolId,
        name: part.functionCall.name,
        input: part.functionCall.args
      });
    }
  }

  const usage = geminiRes.usageMetadata || {};

  return {
    id: 'msg_' + nanoid(24),
    type: 'message',
    role: 'assistant',
    model: reqModel,
    content: contentBlocks,
    stop_reason: mapStopReason(candidate.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0
    }
  };
}
