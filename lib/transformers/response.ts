import { mapStopReason } from './stop-reason';
import { nanoid } from 'nanoid';
import { repairToolInput } from './repair';
import { recoverActionText } from './action-recovery';
import { setexBestEffort } from './metadata-persist';
import { shouldRecoverActionText } from './adaptive-action-policy';

export async function transformGeminiToAnthropic(
  geminiRes: any,
  reqModel: string,
  toolIdMap: Map<string, string>,
  toolSchemas?: Map<string, any>,
  originalToolNames?: Map<string, string>,
  internalModel?: string,
) {
  const candidate = geminiRes.candidates?.[0];
  if (!candidate) {
    throw new Error('No candidate returned from Gemini');
  }

  const contentBlocks: any[] = [];
  // Collect all Redis persistence tasks; flush as one parallel batch at the end
  // so we don't add N sequential RTTs before returning the response.
  const redisTasks: Promise<any>[] = [];

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

      while (true) {
        const recovered = recoverActionText(cleanedText);
        if (!recovered) break;
        if (!shouldRecoverActionText(internalModel, cleanedText, recovered)) break;

        const before = cleanedText.slice(0, recovered.start).trim();
        if (before) contentBlocks.push({ type: 'text', text: before });

        const toolId = 'toolu_' + nanoid(24);
        const originalName = originalToolNames?.get(recovered.toolName) || recovered.toolName;
        const schema = toolSchemas?.get(originalName) || toolSchemas?.get(recovered.toolName);
        const repairedInput = repairToolInput(recovered.args, schema);

        contentBlocks.push({ type: 'tool_use', id: toolId, name: originalName, input: repairedInput });
        toolIdMap.set(toolId, originalName);
        redisTasks.push(setexBestEffort(`gemini:toolname:${toolId}`, 3600, originalName));

        console.info('[action-recovery] recovered action text as tool_use', {
          source: 'response',
          toolName: originalName,
          recoveredChars: recovered.raw.length,
        });

        cleanedText = cleanedText.slice(recovered.end).trim();
      }

      if (cleanedText) {
        contentBlocks.push({ type: 'text', text: cleanedText });
      }
    } else if (part.functionCall) {
      const toolId = 'toolu_' + nanoid(24);
      const geminiName = part.functionCall.name; // sanitized — matches Gemini declaration
      const originalName = originalToolNames?.get(geminiName) || geminiName; // original Anthropic name
      toolIdMap.set(toolId, originalName);

      // Store the GEMINI (sanitized) name so request.ts can send the correct
      // functionResponse.name on the next turn. Using originalName here would
      // cause a 400 for any MCP tool whose name contains hyphens or dots.
      redisTasks.push(setexBestEffort(`gemini:toolname:${toolId}`, 3600, geminiName));
      if (part.thoughtSignature) {
        redisTasks.push(setexBestEffort(`gemini:thought:${toolId}`, 3600, part.thoughtSignature));
      }

      const repairedInput = repairToolInput(
        part.functionCall.args,
        toolSchemas?.get(originalName) || toolSchemas?.get(geminiName)
      );

      contentBlocks.push({
        type: 'tool_use',
        id: toolId,
        name: originalName, // Claude Code sees the original Anthropic tool name
        input: repairedInput
      });
    }
  }

  // Flush all Redis writes in parallel — a single batch instead of N serial RTTs.
  if (redisTasks.length > 0) {
    await Promise.all(redisTasks).catch(() => {});
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
