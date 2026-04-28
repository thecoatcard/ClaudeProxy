import { NextResponse } from 'next/server';
import { extractToken, validateUserKey } from '@/lib/auth';
import { transformRequestToGemini } from '@/lib/transformers/request';
import { transformGeminiToAnthropic } from '@/lib/transformers/response';
import { transformStream } from '@/lib/transformers/stream';
import { executeWithRetry } from '@/lib/retry-engine';
import { logRequest } from '@/lib/logger';
import { incrementRequestCount, incrementErrorCount, recordLatency } from '@/lib/metrics';

export const runtime = 'edge';

export async function POST(req: Request) {
  const startTime = Date.now();
  const token = extractToken(req);
  
  if (!token) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } }, { status: 401 });
  }

  const isValid = await validateUserKey(token);
  if (!isValid) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON" } }, { status: 400 });
  }

  const { model, stream } = body;
  if (!model) {
    return NextResponse.json({ type: "error", error: { type: "invalid_request_error", message: "Model is required" } }, { status: 400 });
  }

  await incrementRequestCount();

  const toolIdMap = new Map<string, string>();
  const geminiReq = await transformRequestToGemini(body, toolIdMap);

  try {
    const res = await executeWithRetry(model, geminiReq, stream || false);

    if (stream) {
      if (!res.body) throw new Error("No stream body");
      const transformIterator = transformStream(res.body, model, toolIdMap);
      
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
          }
        }
      });

      return new Response(streamBody, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        }
      });
    } else {
      const geminiRes = await res.json();
      const anthropicRes = await transformGeminiToAnthropic(geminiRes, model, toolIdMap);
      
      recordLatency(Date.now() - startTime);
      logRequest({
        model,
        stream: false,
        latency: Date.now() - startTime,
        status: 200
      });

      return NextResponse.json(anthropicRes);
    }
  } catch (err: any) {
    await incrementErrorCount();
    recordLatency(Date.now() - startTime);
    
    if (err.message === 'overloaded_error') {
      return NextResponse.json({ type: "error", error: { type: "overloaded_error", message: "All Gemini keys exhausted or failing" } }, { status: 529 });
    }
    if (err.status === 400) {
      const geminiMsg = err.data?.error?.message || "Bad Request / Safety Block";
      return NextResponse.json({ type: "error", error: { type: "invalid_request_error", message: geminiMsg } }, { status: 400 });
    }
    
    return NextResponse.json({ type: "error", error: { type: "api_error", message: "Internal Server Error" } }, { status: 500 });
  }
}
