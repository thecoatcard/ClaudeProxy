import { nanoid } from 'nanoid';
import { mapStopReason } from './stop-reason';
import { redis } from '../redis';
import { repairToolInput } from './repair';

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
}

import { transformRequestToGemini } from './request';
import { executeWithRetry } from '../retry-engine';

export async function* transformStream(
  anthropicBody: any,
  reqModel: string,
  internalModel: string,
  token: string,
  usageRef?: StreamUsage
) {
  const msgId = 'msg_' + nanoid(24);
  const toolIdMap = new Map<string, string>();
  const toolSchemas = new Map<string, any>();
  const originalToolNames = new Map<string, string>();
  
  // State variables for the stream
  let contentBlockIndex = 0;
  let inContentBlock = false;
  let currentToolId: string | null = null;
  let inToolCall = false;
  let inThinking = false;
  let pendingThinkingSignature: string | null = null;
  let fullText = '';
  let cleanedText = '';
  let outputTextLength = 0;
  let finalFinishReason: string | null = null;
  let finalOutputTokens = 0;
  let sawToolUse = false;

  const prefixes = [
    '<', '<t', '<th', '<thi', '<thin', '<think',
    '<tho', '<thou', '<thoug', '<though', '<thought',
    '[', '[A', '[Ac', '[Act', '[Acti', '[Actio', '[Action', '[Action:'
  ];

  try {
    // 1. Send initial events IMMEDIATELY to satisfy platform "initial response" timeouts (e.g. 25s on Vercel)
    yield `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: reqModel,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })}\n\n`;

    yield `event: ping\ndata: {"type":"ping"}\n\n`;

    // 2. Perform the heavy work (Transformation + Execution) INSIDE the stream
    // This work can take >25s on long histories, but the platform timeout is 
    // now averted because we've already sent the headers and initial chunks.
    let geminiReq;
    try {
      geminiReq = await transformRequestToGemini(anthropicBody, toolIdMap, toolSchemas, internalModel, originalToolNames);
    } catch (e: any) {
      console.error("Request transformation failed", e);
      yield `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "Failed to process conversation history" }
      })}\n\n`;
      return;
    }

    let res: Response;
    try {
      res = await executeWithRetry(reqModel, geminiReq, true, token);
    } catch (e: any) {
      console.error("Gemini request failed before stream start", e);
      const msg = e.message || e.data?.error?.message || "Failed to connect to Gemini";
      yield `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message: msg }
      })}\n\n`;
      return;
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error("Gemini error response:", errBody);
      yield `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { 
          type: "api_error", 
          message: errBody?.error?.message || `Gemini error (status ${res.status})` 
        }
      })}\n\n`;
      return;
    }

    if (!res.body) {
      throw new Error("No response body from Gemini");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (value) {
          buffer += decoder.decode(value, { stream: true });
        }
        
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          yield* processLine(line);
        }

        if (done) break;
      }

      if (buffer.trim()) {
        yield* processLine(buffer);
        buffer = '';
      }
    } finally {
      try { reader.releaseLock(); } catch(e) {}
    }

    // Helper to process a single SSE data line from Gemini
    async function* processLine(line: string) {
      if (!line.startsWith('data: ')) return;
      
      const dataStr = line.slice(6).trim();
      if (!dataStr || dataStr === '[DONE]') return;
      
      let chunk;
      try {
        chunk = JSON.parse(dataStr);
      } catch(e) { return; }

      const parts = chunk.candidates?.[0]?.content?.parts || [];
      const finishReason = chunk.candidates?.[0]?.finishReason;
      const usage = chunk.usageMetadata;

      for (const part of parts) {
        // 1. Thinking Blocks (Native Gemini thought field)
        if (part?.thought === true && part?.text) {
          if (inContentBlock) {
            if (outputTextLength < cleanedText.length) {
              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: cleanedText.slice(outputTextLength) }
              })}\n\n`;
            }
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
            contentBlockIndex++;
            inContentBlock = false;
          }
          if (inToolCall) {
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
            contentBlockIndex++;
            inToolCall = false;
            currentToolId = null;
          }
          if (!inThinking) {
            yield `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'thinking', thinking: '' }
            })}\n\n`;
            inThinking = true;
            pendingThinkingSignature = null;
          }
          yield `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: { type: 'thinking_delta', thinking: part.text }
          })}\n\n`;
          if (part.thoughtSignature) {
            pendingThinkingSignature = part.thoughtSignature;
          }
          continue;
        }

        // 2. Text Blocks
        if (part?.text) {
          if (inThinking) {
            if (pendingThinkingSignature) {
              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'signature_delta', signature: pendingThinkingSignature }
              })}\n\n`;
              pendingThinkingSignature = null;
            }
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
            contentBlockIndex++;
            inThinking = false;
          }
          if (inToolCall) {
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
            contentBlockIndex++;
            inToolCall = false;
            currentToolId = null;
          }
          if (!inContentBlock) {
            yield `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'text', text: '' }
            })}\n\n`;
            inContentBlock = true;
            fullText = '';
            cleanedText = '';
            outputTextLength = 0;
          }

          fullText += part.text;
          // Filter out <think> tags if they appear in text (cross-model compatibility)
          cleanedText = fullText.replace(/<(think|thought)>[\s\S]*?(<\/(think|thought)>|$)/gi, '');
          
          // Hallucinated Tool Call Recovery in Stream
          const actionRegex = /\[Action:\s+I\s+am\s+calling\s+tool\s+[`']?([^`'\s]+)[`']?\s+with\s+arguments:\s+(\{[\s\S]*?\})\]/i;
          const match = cleanedText.match(actionRegex);
          if (match) {
            const toolName = match[1];
            const argsStr = match[2];
            const originalName = originalToolNames.get(toolName) || toolName;

            try {
              const args = JSON.parse(argsStr);
              const repairedInput = repairToolInput(args, toolSchemas?.get(toolName));
              
              // 1. Emit the text delta for anything BEFORE the action
              const beforeAction = cleanedText.slice(outputTextLength, match.index);
              if (beforeAction.length > 0) {
                yield `event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: contentBlockIndex,
                  delta: { type: 'text_delta', text: beforeAction }
                })}\n\n`;
              }
              
              // 2. Stop the current text block
              yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
              contentBlockIndex++;
              inContentBlock = false;
              
              // 3. Start and emit the recovered tool call
              const toolId = 'toolu_' + nanoid(24);
              toolIdMap.set(toolId, originalName);
              sawToolUse = true;
              
              yield `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'tool_use', id: toolId, name: originalName, input: {} }
              })}\n\n`;
              
              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(repairedInput) }
              })}\n\n`;
              
              yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
              contentBlockIndex++;
              
              // 4. Update outputTextLength to skip the recovered action
              outputTextLength = (match.index || 0) + match[0].length;
              
              // Persist for history turns
              await redis.setex(`gemini:toolname:${toolId}`, 3600, originalName);
            } catch (e) {
              // Fail silently and let it stream as text if parsing fails
            }
          }

          let safeLength = cleanedText.length;
          for (let i = cleanedText.length - 1; i >= Math.max(0, cleanedText.length - 10); i--) {
            const suffix = cleanedText.slice(i).toLowerCase();
            if (prefixes.includes(suffix)) {
              safeLength = i;
              break;
            }
          }

          if (safeLength > outputTextLength) {
            const newText = cleanedText.slice(outputTextLength, safeLength);
            outputTextLength = safeLength;
            yield `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: newText }
            })}\n\n`;
          }
        }

        // 3. Tool Use Blocks
        if (part?.functionCall) {
          if (inContentBlock) {
            if (outputTextLength < cleanedText.length) {
              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: cleanedText.slice(outputTextLength) }
              })}\n\n`;
            }
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
            contentBlockIndex++;
            inContentBlock = false;
          }

          if (inThinking) {
            if (pendingThinkingSignature) {
              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'signature_delta', signature: pendingThinkingSignature }
              })}\n\n`;
              pendingThinkingSignature = null;
            }
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
            contentBlockIndex++;
            inThinking = false;
          }

          if (inToolCall) {
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
            contentBlockIndex++;
            inToolCall = false;
            currentToolId = null;
          }

          currentToolId = 'toolu_' + nanoid(24);
          const originalName = originalToolNames.get(part.functionCall.name) || part.functionCall.name;
          toolIdMap.set(currentToolId, originalName);
          inToolCall = true;
          sawToolUse = true;

          yield `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: { type: 'tool_use', id: currentToolId, name: originalName, input: {} }
          })}\n\n`;

          // Persistence for next turn (non-blocking best effort)
          try {
            const redisPromises = [
              redis.setex(`gemini:toolname:${currentToolId}`, 3600, part.functionCall.name)
            ];
            if (part.thoughtSignature) {
              redisPromises.push(redis.setex(`gemini:thought:${currentToolId}`, 3600, part.thoughtSignature));
            }
            await Promise.race([
              Promise.all(redisPromises),
              new Promise(r => setTimeout(r, 500))
            ]);
          } catch (e) {
            console.error("Redis sync error in stream", e);
          }

          const repairedArgs = repairToolInput(
            part.functionCall.args,
            toolSchemas?.get(part.functionCall.name)
          );

          yield `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(repairedArgs) }
          })}\n\n`;
        }
      }

      if (finishReason) finalFinishReason = finishReason;
      if (usage?.candidatesTokenCount != null) finalOutputTokens = usage.candidatesTokenCount;
      if (usageRef) {
        if (usage?.promptTokenCount != null) usageRef.inputTokens = usage.promptTokenCount;
        if (usage?.candidatesTokenCount != null) usageRef.outputTokens = usage.candidatesTokenCount;
      }
    }

    // FINAL CLEANUP AND CLOSING EVENTS
    if (inContentBlock && outputTextLength < cleanedText.length) {
      yield `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: cleanedText.slice(outputTextLength) }
      })}\n\n`;
    }
    if (inThinking && pendingThinkingSignature) {
      yield `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'signature_delta', signature: pendingThinkingSignature }
      })}\n\n`;
      pendingThinkingSignature = null;
    }
    if (inContentBlock || inToolCall || inThinking) {
      yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
    }

    const stopReason = sawToolUse ? 'tool_use' : mapStopReason(finalFinishReason || 'STOP');
    yield `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: finalOutputTokens }
    })}\n\n`;

    yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;

  } catch (err) {
    console.error("Stream transformation failed", err);
    // CRITICAL: Always send message_stop to prevent agent from hanging
    yield `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Stream transformation failed"}}\n\n`;
    yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  }
}
