import { NextResponse } from 'next/server';
import { extractToken, validateUserKey } from '@/lib/auth';
import { transformRequestToGemini } from '@/lib/transformers/request';
import { transformGeminiToAnthropic } from '@/lib/transformers/response';
import { transformStream, type StreamUsage } from '@/lib/transformers/stream';
import { executeWithRetry } from '@/lib/retry-engine';
import { getModelMapping } from '@/lib/model-router';
import { logRequest } from '@/lib/logger';
import { incrementRequestCount, incrementErrorCount, recordLatency, recordTokens } from '@/lib/metrics';
import { tryOptimizations } from '@/lib/transformers/optimizations';
import { transformError } from '@/lib/transformers/errors';
import { runWithWebSearch } from '@/lib/tools/search-executor';
import { callGemini } from '@/lib/gemini-adapter';
import { getHealthiestKeyObj } from '@/lib/key-manager';
import { logActivity, maskToken } from '@/lib/activity';

// Node.js runtime required: ioredis uses TCP sockets unavailable in Edge.
export const runtime = 'nodejs';
export const maxDuration = 300; // Increase timeout to 5 minutes

/** Headers Claude Code (and other Anthropic SDKs) inject that must be forwarded
 *  or silently ignored. We do NOT propagate them to Gemini — they're consumed
 *  here in the gateway. Unknown betas are ignored rather than rejected. */
const ANTHROPIC_PASSTHROUGH_HEADERS = [
  'anthropic-version',
  'anthropic-beta',
  'x-api-key',
] as const;

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Allow': 'POST, OPTIONS, HEAD',
      'Anthropic-Version': '2023-06-01',
    },
  });
}

export async function HEAD() {
  return new Response(null, {
    status: 204,
    headers: {
      'Allow': 'POST, OPTIONS, HEAD',
      'Anthropic-Version': '2023-06-01',
    },
  });
}

export async function POST(req: Request) {
  const startTime = Date.now();
  
  // 1. Auth check
  const token = extractToken(req);
  if (!token) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } }, { status: 401 });
  }

  // 2. Parse Body
  let body: any;
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON" } }, { status: 400 });
  }

  const { model, stream } = body;
  if (!model) {
    return NextResponse.json({ type: "error", error: { type: "invalid_request_error", message: "Model is required" } }, { status: 400 });
  }

  // 3. Local Optimizations (Fast-path for Claude Code probes)
  const optimized = await tryOptimizations(body);
  if (optimized) {
    await recordLatency(Date.now() - startTime);
    await recordTokens(optimized.usage.input_tokens, optimized.usage.output_tokens, { model, userToken: token });
    return NextResponse.json(optimized);
  }

  // 3. Parallel Pre-flight (Auth + Routing)
  const isThinking = !!(body.thinking && body.thinking.type === 'enabled');
  const [isValid, modelMap] = await Promise.all([
    validateUserKey(token),
    getModelMapping(model, {
      thinkingEnabled: isThinking,
      requestBody: body,
      userId: token,
    })
  ]);

  if (!isValid) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } }, { status: 401 });
  }

  await incrementRequestCount({ model, userToken: token });

  const internalModel = modelMap.primary;
  console.info(
    `[routing] requested=${model} resolved=${internalModel} source=${modelMap.routingSource ?? 'unknown'} task=${modelMap.taskType ?? 'unknown'} version=${modelMap.routeVersion ?? '0'}`,
  );

  try {
    if (stream) {
      // Return response IMMEDIATELY to avoid platform "initial response" timeouts (e.g. 25s on Vercel)
      const usageRef: StreamUsage = { inputTokens: 0, outputTokens: 0 };
      
      // All heavy work (Redis lookups, transformation, and Gemini API call) happens 
      // inside transformStream AFTER it has yielded the first headers/chunks.
      const transformIterator = transformStream(body, model, internalModel, token, usageRef, modelMap);

      const streamBody = new ReadableStream({
        async start(controller) {
          // Guard flag: set to true when the client disconnects or the stream ends.
          // All enqueue calls are gated on this to prevent ECONNRESET / ERR_INVALID_STATE.
          let streamClosed = false;

          const safeEnqueue = (chunk: Uint8Array) => {
            if (streamClosed) return;
            try { controller.enqueue(chunk); } catch { streamClosed = true; }
          };

          const pingInterval = setInterval(() => {
            safeEnqueue(new TextEncoder().encode(`event: ping\ndata: {"type":"ping"}\n\n`));
          }, 5000);

          try {
            for await (const chunk of transformIterator) {
              safeEnqueue(new TextEncoder().encode(chunk));
            }
          } catch (e) {
            console.error("Stream error", e);
            await incrementErrorCount({ model, userToken: token });
            safeEnqueue(new TextEncoder().encode(`event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Stream failed"}}\n\n`));
          } finally {
            clearInterval(pingInterval);
            streamClosed = true;
            try { controller.close(); } catch {}
            await recordLatency(Date.now() - startTime);
            await recordTokens(usageRef.inputTokens, usageRef.outputTokens, { model, userToken: token });
            logActivity({
              ts: Date.now(),
              userKey: maskToken(token),
              model,
              geminiModel: internalModel,
              inputTokens: usageRef.inputTokens,
              outputTokens: usageRef.outputTokens,
              latencyMs: Date.now() - startTime,
              retries: 0,
              status: 'success',
              streaming: true,
              fallback: modelMap.primary !== internalModel,
              toolsUsed: 0,
            }).catch(() => {});
          }
        },
        // Called by the runtime when the client closes the connection early.
        cancel() {
          // The closed flag is scoped inside start(); the ping interval will clear
          // itself naturally when the stream ends. Nothing to do here explicitly —
          // the guard in safeEnqueue will block any further writes.
        }
      });

      return new Response(streamBody, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Anthropic-Version': '2023-06-01', // Forward the version header
        }
      });
    } else {
      // For non-streaming, we must still await since the client expects a JSON body
      const toolIdMap = new Map<string, string>();
      const toolSchemas = new Map<string, any>();
      const originalToolNames = new Map<string, string>();
      const { geminiBody, webSearchConfig } = await transformRequestToGemini(body, toolIdMap, toolSchemas, internalModel, originalToolNames, token);

      let geminiRes: any;
      if (webSearchConfig) {
        // Web search mode: run internal search loop with Gemini, then return the
        // final response that doesn't request any more searches.
        const keyObj = await getHealthiestKeyObj(token);
        const apiKey = keyObj?.key ?? '';
        geminiRes = await runWithWebSearch(geminiBody, {
          webSearchConfig,
          callGemini: (b) => callGemini(internalModel, apiKey, b, false),
        });
      } else {
        const res = await executeWithRetry(model, geminiBody, false, token, modelMap);
        geminiRes = await res.json();
      }
      const anthropicRes = await transformGeminiToAnthropic(geminiRes, model, toolIdMap, toolSchemas, originalToolNames, internalModel);

      await recordLatency(Date.now() - startTime);
      await recordTokens(anthropicRes.usage.input_tokens, anthropicRes.usage.output_tokens, { model, userToken: token });
      logRequest({
        model,
        resolvedModel: internalModel,
        routingSource: modelMap.routingSource,
        routeVersion: modelMap.routeVersion,
        taskType: modelMap.taskType,
        taskReason: modelMap.taskReason,
        stream: false,
        latency: Date.now() - startTime,
        status: 200
      });
      logActivity({
        ts: Date.now(),
        userKey: maskToken(token),
        model,
        geminiModel: internalModel,
        inputTokens: anthropicRes.usage.input_tokens,
        outputTokens: anthropicRes.usage.output_tokens,
        latencyMs: Date.now() - startTime,
        retries: 0,
        status: 'success',
        streaming: false,
        fallback: modelMap.primary !== internalModel,
        routingSource: modelMap.routingSource,
        routeVersion: modelMap.routeVersion,
        taskType: modelMap.taskType,
        taskReason: modelMap.taskReason,
        toolsUsed: (anthropicRes.content ?? []).filter((b: { type: string }) => b.type === 'tool_use').length,
      }).catch(() => {});

      return NextResponse.json(anthropicRes);
    }
  } catch (err: any) {
    await incrementErrorCount({ model, userToken: token });
    const anthropicErr = transformError(err);
    return NextResponse.json(anthropicErr, { status: anthropicErr.error.type === 'overloaded_error' ? 529 : (err.status || 500) });
  }
}
