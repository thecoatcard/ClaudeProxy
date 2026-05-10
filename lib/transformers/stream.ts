import { nanoid } from 'nanoid';
import { mapStopReason } from './stop-reason';
import { repairToolInput } from './repair';
import { recoverActionText } from './action-recovery';
import { setexBestEffort } from './metadata-persist';
import { shouldRecoverActionText } from './adaptive-action-policy';
import { withTimeout } from '../runtime/response-watchdog';

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
}

import { transformRequestToGemini } from './request';
import { executeWithRetry } from '../retry-engine';
import type { ModelRoute } from '../model-router';
import { incrementErrorCount } from '../metrics';

export async function* transformStream(
  anthropicBody: any,
  reqModel: string,
  internalModel: string,
  token: string,
  usageRef?: StreamUsage,
  routePlan?: ModelRoute,
  requestId?: string,
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
    let geminiReq: any;
    let webSearchConfig: import('./request').WebSearchConfig | null = null;
    let requestContext: import('./request').GatewayRequestContext | undefined;
    try {
      const transformed = await transformRequestToGemini(anthropicBody, toolIdMap, toolSchemas, internalModel, originalToolNames, token, requestId);
      geminiReq = transformed.geminiBody;
      webSearchConfig = transformed.webSearchConfig;
      requestContext = transformed.requestContext;
    } catch (e: any) {
      console.error("Request transformation failed", e);
      yield `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "Failed to process conversation history" }
      })}\n\n`;
      return;
    }

    // ── Web search pre-execution loop ────────────────────────────────────────
    // When the request includes a web_search tool, we run all searches
    // synchronously (non-streaming) before opening the final Gemini SSE stream.
    // This keeps the streaming protocol intact: the stream starts only after
    // all search results have been injected into the Gemini context.
    if (webSearchConfig) {
      try {
        const { runWithWebSearch } = await import('../tools/search-executor');
        const { getHealthiestKeyObj: getKey } = await import('../key-manager');
        const { callGemini: cg } = await import('../gemini-adapter');
        const keyObj = await getKey(token);
        const apiKey = keyObj?.key ?? '';
        // Build a non-streaming body to run the loop.
        const nonStreamBody = { ...geminiReq };
        const finalJson = await runWithWebSearch(nonStreamBody, {
          webSearchConfig,
          callGemini: (b) => cg(internalModel, apiKey, b, false),
        });
        // Extract the enriched contents from the resolved body. The search
        // executor mutated its internal copy; we reconstruct from the last model
        // turn to inject search results into the streaming request.
        const lastParts = finalJson?.candidates?.[0]?.content?.parts ?? [];
        const hasSearchCall = lastParts.some((p: any) => p.functionCall?.name === 'web_search');
        if (!hasSearchCall && finalJson?.candidates?.[0]) {
          // All searches done — pass the final JSON directly to the SSE synthetic
          // stream path below by converting the JSON to SSE events and returning.
          // (For now, re-inject as context so the streaming call continues cleanly.)
          // This is a simple approach: we already have the final answer, emit it.
          const text = lastParts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join('');
          if (text) {
            const blockIdx = contentBlockIndex++;
            yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } })}\n\n`;
            yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text } })}\n\n`;
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIdx })}\n\n`;
            const usage = finalJson?.usageMetadata;
            yield `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage?.candidatesTokenCount ?? text.length >> 2 } })}\n\n`;
            yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
            if (usageRef) {
              usageRef.inputTokens = usage?.promptTokenCount ?? 0;
              usageRef.outputTokens = usage?.candidatesTokenCount ?? 0;
            }
            return;
          }
        }
        // Fall through to normal streaming with enriched context if there are
        // still pending steps or no text was produced.
      } catch (e) {
        console.warn('[stream] web search loop error, proceeding without search results', e);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    let res: Response;
    try {
      res = await executeWithRetry(reqModel, geminiReq, true, token, routePlan, requestId, requestContext);
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
        const { done, value } = await withTimeout(
          reader.read(),
          30_000,
          'stream-chunk-read',
        );
        
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
          
          // If action-style tool text appears in the text stream and is fully
          // parseable, recover it into a structured tool_use block.
          //
          // BUG-003 FIX: track `actionSearchOffset` so each iteration searches
          // only the *unprocessed* suffix of cleanedText. Without this, the loop
          // re-matches the same action on every iteration (infinite loop / duplicate
          // tool_use emissions). The offset is kept separate from outputTextLength
          // because outputTextLength may be held back by the prefix-suffix guard below.
          let actionSearchOffset = outputTextLength;
          while (true) {
            const searchSlice = cleanedText.slice(actionSearchOffset);
            const recovered = recoverActionText(searchSlice);
            if (!recovered) break;
            // Translate relative positions back to absolute positions in cleanedText.
            const absStart = actionSearchOffset + recovered.start;
            const absEnd   = actionSearchOffset + recovered.end;
            const absRecovered = { ...recovered, start: absStart, end: absEnd };
            if (!shouldRecoverActionText(internalModel, cleanedText, absRecovered)) break;

            const originalName = originalToolNames.get(recovered.toolName) || recovered.toolName;
            const schema = toolSchemas?.get(originalName) || toolSchemas?.get(recovered.toolName);
            const repairedInput = repairToolInput(recovered.args, schema);

            // 1. Emit the text delta for anything before the action marker.
            const beforeAction = cleanedText.slice(outputTextLength, absStart);
            if (beforeAction.length > 0) {
              yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: beforeAction }
              })}\n\n`;
            }

            // 2. Close current text block.
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
            contentBlockIndex++;
            inContentBlock = false;

            // 3. Emit recovered tool_use.
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

            outputTextLength = absEnd;
            actionSearchOffset = absEnd; // Advance search past this action — prevents re-match

            console.info('[action-recovery] recovered action text as tool_use', {
              source: 'stream',
              toolName: originalName,
              recoveredChars: recovered.raw.length,
            });

            // Persist for history turns — fire-and-forget so stream is not blocked.
            setexBestEffort(`gemini:toolname:${toolId}`, 3600, originalName).catch(() => {});

            // Start a new text block if we still have trailing text.
            if (!inContentBlock) {
              yield `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' }
              })}\n\n`;
              inContentBlock = true;
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

          // Persistence for next turn — truly fire-and-forget.
          // DO NOT await this: every await here stalls SSE delivery to the client.
          const redisPromises = [
            setexBestEffort(`gemini:toolname:${currentToolId}`, 3600, part.functionCall.name)
          ];
          if (part.thoughtSignature) {
            redisPromises.push(setexBestEffort(`gemini:thought:${currentToolId}`, 3600, part.thoughtSignature));
          }
          Promise.all(redisPromises).catch(e => console.error('Redis persist error in stream', e));

          const repairedArgs = repairToolInput(
            part.functionCall.args,
            toolSchemas?.get(originalName) || toolSchemas?.get(part.functionCall.name)
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
    await incrementErrorCount({ model: reqModel, userToken: token }).catch(() => {});
    // BUG-006 FIX: close any open content blocks before emitting error/stop.
    // An unclosed block leaves the client SSE parser in a broken state.
    if (inContentBlock || inToolCall || inThinking) {
      yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`;
    }
    const stopReason = sawToolUse ? 'tool_use' : 'end_turn';
    yield `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: finalOutputTokens }
    })}\n\n`;
    // CRITICAL: Always send message_stop to prevent agent from hanging
    yield `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Stream transformation failed"}}\n\n`;
    yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  }
}
