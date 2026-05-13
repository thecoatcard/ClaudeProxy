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
import { performEmergencyCompaction } from '../context/emergency-compactor';
import { recoverFromOverload } from '../recovery/overload-recovery';

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
  let sawAnyOutput = false;
  let firstTokenEmittedAt: number | null = null;
  const streamStartedAt = Date.now();

  const prefixes = [
    '<', '<t', '<th', '<thi', '<thin', '<think',
    '<tho', '<thou', '<thoug', '<though', '<thought',
    '[', '[A', '[Ac', '[Act', '[Acti', '[Actio', '[Action', '[Action:'
  ];

  function buildEmptyResponseRetryRoute(retryCount = 0): ModelRoute | null {
    const configuredChain = routePlan
      ? [routePlan.primary, ...(routePlan.fallback || [])]
      : [internalModel, 'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-flash-latest'];
    const seen = new Set<string>();
    const candidates = configuredChain.filter((modelName) => {
      if (!modelName || modelName === internalModel || seen.has(modelName)) return false;
      seen.add(modelName);
      return true;
    });
    
    if (candidates.length === 0) {
      // If no configured fallbacks, force a move to Gemma as a last resort
      // for "empty" errors since it's much more likely to return text.
      if (!internalModel.startsWith('gemma')) return {
        primary: 'gemma-4-31b-it',
        fallback: ['gemma-4-26b-a4b-it'],
        taskType: 'REASONING',
        taskReason: 'empty-stream-forced-gemma',
      };
      return null;
    }

    // On second retry, skip straight to the best available fallback
    const idx = Math.min(retryCount, candidates.length - 1);
    const capableFallback = candidates[idx];
    const fallback = candidates.slice(idx + 1);

    return {
      ...(routePlan || { fallback: [] }),
      primary: capableFallback,
      fallback,
      taskType: routePlan?.taskType === 'CHAT' ? 'HEAVY_CODING' : routePlan?.taskType,
      taskReason: `empty-stream-retry-${retryCount + 1}`,
    };
  }

  function withEmptyResponseRecoveryGuidance(body: any): any {
    const recoveryText = [
      '[GATEWAY RECOVERY]',
      'The previous upstream attempt returned no assistant content.',
      'Continue the current user request from the conversation history.',
      'If a tool is needed, emit the tool call. Otherwise provide a concise next step.',
      'Do not return an empty response.',
    ].join(' ');

    const existingParts = Array.isArray(body?.systemInstruction?.parts)
      ? body.systemInstruction.parts
      : [];

    return {
      ...body,
      systemInstruction: {
        ...(body?.systemInstruction || {}),
        parts: [...existingParts, { text: recoveryText }],
      },
      // Lower temperature slightly to encourage a more deterministic/stable response
      generationConfig: {
        ...(body?.generationConfig || {}),
        temperature: Math.max(0, (body?.generationConfig?.temperature ?? 0.4) - 0.2),
      },
    };
  }

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
            sawAnyOutput = true;
            if (firstTokenEmittedAt === null) firstTokenEmittedAt = Date.now();
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

    let res: Response | null = null;
    try {
      res = await executeWithRetry(reqModel, geminiReq, true, token, routePlan, requestId, requestContext);
    } catch (e: any) {
      console.error("Gemini request failed before stream start", e);
      const msg = e.message || e.data?.error?.message || "Failed to connect to Gemini";
      const isOverload = /overload|overloaded|529|resource_exhausted|capacity/i.test(String(msg));
      if (isOverload) {
        // Keep connection active: compact + retry once before returning fallback text.
        try {
          const compacted = await performEmergencyCompaction(geminiReq, {
            ...requestContext,
            requestId,
            userId: token,
          });
          if (compacted.compacted) {
            const retried = await executeWithRetry(reqModel, compacted.body, true, token, routePlan, requestId, requestContext);
            if (retried.ok) {
              res = retried;
            }
          }
        } catch (retryErr) {
          console.warn('[stream] overload retry after emergency compaction failed', retryErr);
        }
      }

      if (!res) {
        if (isOverload) {
          // Never show the overload message — keep trying across more models and keys.
          for (let extraAttempt = 1; extraAttempt <= 3 && !res; extraAttempt++) {
            try {
              const recovered = await recoverFromOverload({
                currentModel: reqModel,
                currentKeyId: 'unknown',
                triedModels: new Set([reqModel]),
                attempt: extraAttempt,
                body: geminiReq,
                userId: token,
              });
              if (recovered.backoffMs) await new Promise(r => setTimeout(r, recovered.backoffMs));
              const bodyToUse = extraAttempt === 1 ? (await performEmergencyCompaction(geminiReq, { ...requestContext, requestId, userId: token })).body ?? geminiReq : geminiReq;
              const r = await executeWithRetry(recovered.newModel || reqModel, bodyToUse, true, token, routePlan, requestId, requestContext);
              if (r.ok) { res = r; }
            } catch { /* continue */ }
          }
          if (!res) {
            // All attempts exhausted — emit a generic recoverable error instead of capacity text.
            yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Service temporarily unavailable. Please try again.' } })}\n\n`;
            yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
            return;
          }
        } else {
          yield `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: "api_error", message: msg }
          })}\n\n`;
          // Always close the SSE protocol frame to prevent client-side hangs.
          yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
          return;
        }
      }
    }

    if (!res) {
      yield `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "No response from model" }
      })}\n\n`;
      yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
      return;
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error("Gemini error response:", errBody);
      const errMsg = errBody?.error?.message || `Gemini error (status ${res.status})`;
      const isOverload = res.status === 529 || res.status === 503 || /overload|overloaded|resource_exhausted|capacity/i.test(String(errMsg));
      if (isOverload) {
        // Never show the overload message — keep trying across more models and keys.
        let recovered: Response | null = null;
        for (let extraAttempt = 1; extraAttempt <= 3 && !recovered; extraAttempt++) {
          try {
            const rec = await recoverFromOverload({
              currentModel: reqModel,
              currentKeyId: 'unknown',
              triedModels: new Set([reqModel]),
              attempt: extraAttempt,
              body: geminiReq,
              userId: token,
            });
            if (rec.backoffMs) await new Promise(r => setTimeout(r, rec.backoffMs));
            const bodyToUse = extraAttempt === 1 ? (await performEmergencyCompaction(geminiReq, { ...requestContext, requestId, userId: token })).body ?? geminiReq : geminiReq;
            const r = await executeWithRetry(rec.newModel || reqModel, bodyToUse, true, token, routePlan, requestId, requestContext);
            if (r.ok) { recovered = r; }
          } catch { /* continue */ }
        }
        if (recovered) { res = recovered; }
        else {
          yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Service temporarily unavailable. Please try again.' } })}\n\n`;
          yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
          return;
        }
      }
      yield `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { 
          type: "api_error", 
          message: errMsg 
        }
      })}\n\n`;
      // Always close the SSE protocol frame to prevent client-side hangs.
      yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
      return;
    }

    yield* drainGeminiResponse(res);

    if (!sawAnyOutput && !sawToolUse) {
      let retryRoute = buildEmptyResponseRetryRoute(0);
      let retryCount = 0;
      
      while (retryRoute && !sawAnyOutput && !sawToolUse && retryCount < 2) {
        console.warn(`[stream] empty model response (attempt ${retryCount + 1}); retrying with ${retryRoute.primary}`, {
          requestId,
          fromModel: internalModel,
          toModel: retryRoute.primary,
          finishReason: finalFinishReason,
        });

        finalFinishReason = null;
        finalOutputTokens = 0;
        fullText = '';
        cleanedText = '';
        outputTextLength = 0;
        pendingThinkingSignature = null;

        try {
          const retryRes = await executeWithRetry(
            reqModel,
            withEmptyResponseRecoveryGuidance(geminiReq),
            true,
            token,
            retryRoute,
            requestId,
            requestContext,
          );
          if (retryRes.ok) {
            yield* drainGeminiResponse(retryRes);
          } else {
            console.warn('[stream] empty-response fallback returned non-ok status', {
              requestId,
              status: retryRes.status,
            });
            break; 
          }
        } catch (retryErr) {
          console.warn('[stream] empty-response fallback failed', retryErr);
          break;
        }
        
        retryCount++;
        retryRoute = buildEmptyResponseRetryRoute(retryCount);
      }
    }

    async function* drainGeminiResponse(response: Response) {
      if (!response.body) {
        throw new Error("No response body from Gemini");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

    try {
      while (true) {
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          // 90 s covers extended Gemini thinking phases (previously 30 s was too
          // short and killed streams mid-response on long agent runs).
          ({ done, value } = await withTimeout(
            reader.read(),
            90_000,
            'stream-chunk-read',
          ));
        } catch (readErr: any) {
          if (readErr?.message?.startsWith('Timeout:')) {
            // No new bytes from Gemini in 90 s — Gemini has likely stalled.
            // Close the loop cleanly; the finally block will emit message_stop.
            console.warn('[stream] Gemini chunk read timed out after 90 s — closing stream gracefully');
            break;
          }
          throw readErr; // real network error — propagate to outer catch
        }

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
              sawAnyOutput = true;
              if (firstTokenEmittedAt === null) firstTokenEmittedAt = Date.now();
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
          sawAnyOutput = true;
          if (firstTokenEmittedAt === null) firstTokenEmittedAt = Date.now();
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
              sawAnyOutput = true;
              if (firstTokenEmittedAt === null) firstTokenEmittedAt = Date.now();
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
            sawAnyOutput = true;

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
            sawAnyOutput = true;
            if (firstTokenEmittedAt === null) firstTokenEmittedAt = Date.now();
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
              sawAnyOutput = true;
              if (firstTokenEmittedAt === null) firstTokenEmittedAt = Date.now();
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
          sawAnyOutput = true;

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
      sawAnyOutput = true;
      if (firstTokenEmittedAt === null) firstTokenEmittedAt = Date.now();
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

    // When the model returns no content with no tool use, inject a visible
    // placeholder so the client does not silently hang waiting for content.
    // Use emitted-content state instead of usage tokens; some providers omit
    // usageMetadata even when they streamed valid text.
    if (!sawAnyOutput && !sawToolUse) {
      const idx = contentBlockIndex + (inContentBlock || inToolCall || inThinking ? 1 : 0);
      yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } })}\n\n`;
      const isFiltered = finalFinishReason === 'SAFETY' || finalFinishReason === 'RECITATION';
      const placeholder = isFiltered
        ? `[Model response filtered by safety policies (FinishReason: ${finalFinishReason}). Please refine your request.]`
        : '[Model returned an empty response. Please retry.]';
      yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: placeholder } })}\n\n`;
      yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
    }

    // Determine stop reason.
    // MAX_TOKENS overrides tool_use: the model was cut off mid-response, so
    // emitting 'tool_use' would mislead Claude Code into thinking tool execution
    // completed normally. Sending 'max_tokens' lets the client handle truncation.
    const stopReason = finalFinishReason === 'MAX_TOKENS'
      ? 'max_tokens'
      : sawToolUse
        ? 'tool_use'
        : mapStopReason(finalFinishReason || 'STOP');
    yield `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: finalOutputTokens }
    })}\n\n`;

    // Emit structured TTFT telemetry so the server log shows latency breakdown.
    const totalMs = Date.now() - streamStartedAt;
    const ttftMs = firstTokenEmittedAt !== null ? firstTokenEmittedAt - streamStartedAt : totalMs;
    console.info('[stream] completed', JSON.stringify({
      requestId,
      ttft_ms: ttftMs,
      total_ms: totalMs,
      output_tokens: finalOutputTokens,
      stop_reason: stopReason,
      saw_tool_use: sawToolUse,
    }));

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
