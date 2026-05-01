import { mapStopReason } from './stop-reason';
import { nanoid } from 'nanoid';
import { redis } from '../redis';
import { repairToolInput } from './repair';

export async function transformGeminiToAnthropic(
  geminiRes: any,
  reqModel: string,
  toolIdMap: Map<string, string>,
  toolSchemas?: Map<string, any>
) {
  const candidate = geminiRes.candidates?.[0];
  if (!candidate) {
    throw new Error('No candidate returned from Gemini');
  }

  const contentBlocks: any[] = [];

  for (const part of candidate.content?.parts || []) {
    // Gemini returns reasoning as parts with `thought: true` when
    // thinkingConfig.includeThoughts was set on the request. Surface these
    // as Anthropic thinking blocks so Claude Code can render them AND feed
    // them back on subsequent turns.
    if (part.thought === true && part.text) {
      const block: any = { type: 'thinking', thinking: part.text };
      if (part.thoughtSignature) block.signature = part.thoughtSignature;
      contentBlocks.push(block);
      continue;
    }

    if (part.text) {
      // Strip legacy <think>/<thought> text that some Gemini models still emit
      // inline when thoughtConfig isn't honored. Real thoughts are already
      // captured above, so anything left here is fallback garbage.
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
      
      await redis.setex(`gemini:toolname:${toolId}`, 3600, part.functionCall.name);
      const sig = part.thoughtSignature || part.thought_signature;
      if (sig) {
        await redis.setex(`gemini:thought:${toolId}`, 3600, sig);
      }

      const repairedInput = repairToolInput(
        part.functionCall.args,
        toolSchemas?.get(part.functionCall.name)
      );

      contentBlocks.push({
        type: 'tool_use',
        id: toolId,
        name: part.functionCall.name,
        input: repairedInput
      });
    }
  }

  const usage = geminiRes.usageMetadata || {};

  // Anthropic expects stop_reason='tool_use' when the turn ends with a tool call,
  // but Gemini reports finishReason='STOP' in that case.
  const hasToolUse = contentBlocks.some(b => b.type === 'tool_use');
  const stopReason = hasToolUse ? 'tool_use' : mapStopReason(candidate.finishReason);

  return {
    id: 'msg_' + nanoid(24),
    type: 'message',
    role: 'assistant',
    model: reqModel,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0
    }
  };
}
