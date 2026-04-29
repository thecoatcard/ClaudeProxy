import { BlockPolicy } from './block-policy';
import { ThinkTagParser, ContentType } from './thinking-parser';
import { redis } from '../redis';
import { nanoid } from 'nanoid';
import { repairToolInput } from './repair';

export async function* transformStream(
  geminiStream: ReadableStream,
  reqModel: string,
  toolIdMap: Map<string, string>,
  toolSchemas: Map<string, any>,
  usageRef: { input_tokens: number; output_tokens: number }
) {
  const reader = geminiStream.getReader();
  const policy = new BlockPolicy();
  const tagParser = new ThinkTagParser();
  let messageStarted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = new TextDecoder().decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        
        let data: any;
        try {
          data = JSON.parse(line.slice(6));
        } catch (e) {
          continue;
        }

        // 1. Message Start
        if (!messageStarted) {
          yield `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_' + nanoid(24),
              type: 'message',
              role: 'assistant',
              model: reqModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: usageRef.input_tokens, output_tokens: 0 }
            }
          })}\n\n`;
          messageStarted = true;
        }

        const candidate = data.candidates?.[0];
        if (!candidate) {
          // Check for terminal metadata in non-candidate chunks
          if (data.usageMetadata) {
            usageRef.output_tokens = data.usageMetadata.candidatesTokenCount || usageRef.output_tokens;
          }
          continue;
        }

        // 2. Process Content Parts
        for (const part of candidate.content?.parts || []) {
          // A. Thought Block (Native Gemini Thinking)
          if (part.thought === true && part.text) {
            const [events, index] = policy.getOrStartBlock(0, 'thinking');
            for (const e of events) yield e;
            
            yield `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: index,
              delta: { type: 'thinking_delta', thinking: part.text }
            })}\n\n`;
            continue;
          }

          // B. Function Call
          if (part.functionCall) {
            const [events, index] = policy.getOrStartBlock(0, 'tool_use', { name: part.functionCall.name });
            for (const e of events) yield e;

            const toolId = policy.getToolId(0);
            if (toolId) {
              toolIdMap.set(toolId, part.functionCall.name);
              await redis.setex(`gemini:toolname:${toolId}`, 3600, part.functionCall.name);
              if (part.thoughtSignature) {
                await redis.setex(`gemini:thought:${toolId}`, 3600, part.thoughtSignature);
              }

              const repairedArgs = repairToolInput(
                part.functionCall.args,
                toolSchemas?.get(part.functionCall.name)
              );

              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(repairedArgs) }
              })}\n\n`;
            }
            continue;
          }

          // C. Text Part (with Tag Parsing Fallback)
          if (part.text) {
            for (const chunk of tagParser.feed(part.text)) {
              const type = chunk.type === ContentType.THINKING ? 'thinking' : 'text';
              const [events, index] = policy.getOrStartBlock(0, type);
              for (const e of events) yield e;

              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: index,
                delta: type === 'thinking' 
                  ? { type: 'thinking_delta', thinking: chunk.content }
                  : { type: 'text_delta', text: chunk.content }
              })}\n\n`;
            }
          }
        }

        if (data.usageMetadata) {
          usageRef.output_tokens = data.usageMetadata.candidatesTokenCount || usageRef.output_tokens;
        }
      }
    }

    // Flush remaining text/thinking
    const finalChunk = tagParser.flush();
    if (finalChunk) {
      const type = finalChunk.type === ContentType.THINKING ? 'thinking' : 'text';
      const [events, index] = policy.getOrStartBlock(0, type);
      for (const e of events) yield e;
      yield `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: index,
        delta: type === 'thinking'
          ? { type: 'thinking_delta', thinking: finalChunk.content }
          : { type: 'text_delta', text: finalChunk.content }
      })}\n\n`;
    }

    // Close all open blocks
    for (const e of policy.closeAll()) yield e;

    // 3. Message Stop
    yield `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: usageRef.output_tokens }
    })}\n\n`;

    yield `event: message_stop\ndata: {"type": "message_stop"}\n\n`;

  } catch (error) {
    console.error('Stream Error:', error);
    yield `event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: String(error) }
    })}\n\n`;
  } finally {
    reader.releaseLock();
  }
}
