import { nanoid } from 'nanoid';
import { mapStopReason } from './stop-reason';
import { redis } from '../redis';

export async function* transformStream(
  geminiStream: ReadableStream<Uint8Array>,
  reqModel: string,
  toolIdMap: Map<string, string>
) {
  const msgId = 'msg_' + nanoid(24);
  
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

  const reader = geminiStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let contentBlockIndex = 0;
  let inContentBlock = false;
  let currentToolId: string | null = null;
  let inToolCall = false;

  const prefixes = [
    '<', '<t', '<th', '<thi', '<thin', '<think',
    '<tho', '<thou', '<thoug', '<though', '<thought'
  ];

  let fullText = '';
  let cleanedText = '';
  let outputTextLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          
          let chunk;
          try {
            chunk = JSON.parse(dataStr);
          } catch(e) { continue; }

          const parts = chunk.candidates?.[0]?.content?.parts || [];
          const finishReason = chunk.candidates?.[0]?.finishReason;
          const usage = chunk.usageMetadata;

          for (const part of parts) {
            if (part?.text) {
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

              if (!inToolCall) {
                currentToolId = 'toolu_' + nanoid(24);
                toolIdMap.set(currentToolId, part.functionCall.name);
                inToolCall = true;
                
                yield `event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'tool_use', id: currentToolId, name: part.functionCall.name, input: {} }
                })}\n\n`;
              }
              
              if (part.thoughtSignature && currentToolId) {
                await redis.setex(`gemini:thought:${currentToolId}`, 3600, part.thoughtSignature);
              }
              
              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args) }
              })}\n\n`;
            }
          }

          if (finishReason) {
            if (inContentBlock || inToolCall) {
              if (inContentBlock && outputTextLength < cleanedText.length) {
                yield `event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: contentBlockIndex,
                  delta: { type: 'text_delta', text: cleanedText.slice(outputTextLength) }
                })}\n\n`;
              }
              yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
              inContentBlock = false;
              inToolCall = false;
              currentToolId = null;
            }

            yield `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
              usage: { output_tokens: usage?.candidatesTokenCount ?? 0 }
            })}\n\n`;

            yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
