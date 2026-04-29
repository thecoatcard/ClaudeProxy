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

export const runtime = 'edge';

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
    recordLatency(Date.now() - startTime);
    recordTokens(optimized.usage.input_tokens, optimized.usage.output_tokens);
    return NextResponse.json(optimized);
  }

  // 3. Parallel Pre-flight (Auth + Routing)
  const [isValid, modelMap] = await Promise.all([
    validateUserKey(token),
    getModelMapping(model)
  ]);

  if (!isValid) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } }, { status: 401 });
  }

  await incrementRequestCount();

  const toolIdMap = new Map<string, string>();
  const toolSchemas = new Map<string, any>();
  const internalModel = modelMap.primary;

  // 4. Transform
  const geminiReq = await transformRequestToGemini(body, toolIdMap, toolSchemas, internalModel);

  try {
    const res = await executeWithRetry(model, geminiReq, stream || false, token);

    if (stream) {
      if (!res.body) throw new Error("No stream body");
      const usageRef: StreamUsage = { inputTokens: 0, outputTokens: 0 };
      const transformIterator = transformStream(res.body, model, toolIdMap, toolSchemas, usageRef);

      const streamBody = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of transformIterator) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
          } catch (e) {
            console.error("Stream error", e);
            controller.enqueue(new TextEncoder().encode(`event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Stream failed"}}\n\n`));
          } finally {
            controller.close();
            recordLatency(Date.now() - startTime);
            recordTokens(usageRef.inputTokens, usageRef.outputTokens);
          }
        }
      });

      return new Response(streamBody, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        }
      });
    } else {
      const geminiRes = await res.json();
      const anthropicRes = await transformGeminiToAnthropic(geminiRes, model, toolIdMap, toolSchemas);

      recordLatency(Date.now() - startTime);
      await recordTokens(anthropicRes.usage.input_tokens, anthropicRes.usage.output_tokens);
      logRequest({
        model,
        stream: false,
        latency: Date.now() - startTime,
        status: 200
      });

      return NextResponse.json(anthropicRes);
    }
  } catch (err: any) {
    const anthropicErr = transformError(err);
    return NextResponse.json(anthropicErr, { status: err.status || 500 });
  }
}
