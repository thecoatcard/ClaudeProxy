import { nanoid } from 'nanoid';
import { mapStopReason } from './stop-reason';
import { redis } from '../redis';
import { repairToolInput } from './repair';

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
}

export async function* transformStream(
  geminiResponsePromise: Promise<Response>,
  reqModel: string,
  toolIdMap: Map<string, string>,
  toolSchemas?: Map<string, any>,
  usageRef?: StreamUsage
) {
  const msgId = 'msg_' + nanoid(24);
  
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
    '<tho', '<thou', '<thoug', '<though', '<thought'
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

    // 2. Now await the actual Gemini response (which might take >25s if reasoning is enabled)
    let res: Response;
    try {
      res = await geminiResponsePromise;
    } catch (e: any) {
      console.error("Gemini request failed before stream start", e);
      yield `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message: e.message || "Failed to connect to Gemini" }
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
        
        const lines = buffer.split('\n');
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
          toolIdMap.set(currentToolId, part.functionCall.name);
          inToolCall = true;
          sawToolUse = true;

          yield `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: { type: 'tool_use', id: currentToolId, name: part.functionCall.name, input: {} }
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
