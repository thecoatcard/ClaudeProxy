import { mapStopReason } from './stop-reason';
import { nanoid } from 'nanoid';
import { redis } from '../redis';
import { repairToolInput } from './repair';

export async function transformGeminiToAnthropic(
  geminiRes: any,
  reqModel: string,
  toolIdMap: Map<string, string>,
  toolSchemas?: Map<string, any>,
  originalToolNames?: Map<string, string>
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
      let cleanedText = part.text.replace(/<(think|thought)>[\s\S]*?(<\/(think|thought)>|$)/gi, '');
      const actionRegex = /\[Action:\s+I\s+am\s+calling\s+tool\s+[`']?([^`'\s]+)[`']?\s+with\s+arguments:\s+(\{[\s\S]*?\})\]/i;
      const match = cleanedText.match(actionRegex);
      if (match) {
        const toolName = match[1];
        const argsStr = match[2];
        const toolId = 'toolu_' + nanoid(24);
        const originalName = originalToolNames?.get(toolName) || toolName;
        try {
          const args = JSON.parse(argsStr);
          const repairedInput = repairToolInput(args, toolSchemas?.get(toolName));
          cleanedText = cleanedText.replace(match[0], '').trim();
          contentBlocks.push({ type: 'tool_use', id: toolId, name: originalName, input: repairedInput });
          toolIdMap.set(toolId, originalName);
          await redis.setex(`gemini:toolname:${toolId}`, 3600, originalName);
        } catch (e) { console.warn('[recovery] failed to parse hallucinated tool args', e); }
      }
      if (cleanedText) {
        contentBlocks.push({
          type: 'text',
          text: cleanedText
        });
      }
    } else if (part.functionCall) {
      const toolId = 'toolu_' + nanoid(24);
      const originalName = originalToolNames?.get(part.functionCall.name) || part.functionCall.name;
      toolIdMap.set(toolId, originalName);
      
      await redis.setex(`gemini:toolname:${toolId}`, 3600, originalName);
      if (part.thoughtSignature) {
        await redis.setex(`gemini:thought:${toolId}`, 3600, part.thoughtSignature);
      }

      const repairedInput = repairToolInput(
        part.functionCall.args,
        toolSchemas?.get(part.functionCall.name)
      );

      contentBlocks.push({
        type: 'tool_use',
        id: toolId,
        name: originalName,
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
