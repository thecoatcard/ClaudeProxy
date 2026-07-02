import type { ModelRoute } from '@/lib/model-router';
import { callGemini } from '@/lib/gemini-adapter';
import { getHealthiestKeyObj } from '@/lib/key-manager';
import { recordLatency, recordTokens, incrementErrorCount } from '@/lib/metrics';
import { logRequest } from '@/lib/logger';
import { logActivity, maskToken } from '@/lib/activity';
import { errorOneLiner } from '@/lib/logging/error-summarizer';
import { transformError } from '@/lib/transformers/errors';
import { transformGeminiToAnthropic } from '@/lib/transformers/response';
import { transformRequestToGemini } from '@/lib/transformers/request';
import { transformStream, type StreamUsage } from '@/lib/transformers/stream';
import { executeWithRetry } from '@/lib/retry-engine';
import { runWithWebSearch } from '@/lib/tools/search-executor';
import type {
  ModelExecutionRequest,
  ModelExecutionResponse,
  ModelProvider,
  ProviderHealthSnapshot,
} from './contracts';

type ToolSchema = Record<string, unknown>;
type ProviderExecutionRequest = ModelExecutionRequest & { route: ModelRoute };

export type ModelProviderName = ModelProvider | 'future';

export interface ModelCredential {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface ModelInvocation {
  provider: ModelProviderName;
  model: string;
  body: unknown;
  stream: boolean;
  signal?: AbortSignal;
  requestId?: string;
  timeoutMs?: number;
}

export interface ModelTransportResponse {
  provider: ModelProviderName;
  model: string;
  status: number;
  ok: boolean;
  response: Response;
}

export interface ModelHealthSnapshot {
  provider: ModelProviderName;
  healthy: boolean;
  latencyMs?: number;
  checkedAt: number;
  message?: string;
}

type RuntimeProviderHealthSnapshot = Omit<ProviderHealthSnapshot, 'provider'> & { provider: ModelProviderName };

export interface ModelClient {
  readonly provider: ModelProviderName;
  supports(model: string): boolean;
  execute(request: ProviderExecutionRequest): Promise<ModelExecutionResponse>;
  stream?(request: ProviderExecutionRequest & {
    onError: (error: unknown) => void | Promise<void>;
    onComplete: (usage: StreamUsage) => void | Promise<void>;
  }): Response;
  invoke?(invocation: ModelInvocation, credential: ModelCredential): Promise<ModelTransportResponse>;
  healthCheck?(credential: ModelCredential): Promise<ModelHealthSnapshot>;
}

export class UnsupportedModelProviderError extends Error {
  constructor(provider: string, reason?: string) {
    super(reason ? `Unsupported model provider "${provider}": ${reason}` : `Unsupported model provider "${provider}"`);
    this.name = 'UnsupportedModelProviderError';
  }
}

export class ModelProviderRegistry {
  private readonly clients = new Map<ModelProviderName, ModelClient>();

  register(client: ModelClient) {
    this.clients.set(client.provider, client);
  }

  get(provider: ModelProviderName) {
    const client = this.clients.get(provider);
    if (!client) {
      throw new UnsupportedModelProviderError(provider, 'no client registered');
    }
    return client;
  }

  resolve(model: string, preferredProvider?: ModelProviderName) {
    if (preferredProvider && this.clients.has(preferredProvider)) {
      return this.clients.get(preferredProvider)!;
    }

    for (const client of this.clients.values()) {
      if (client.supports(model)) {
        return client;
      }
    }

    throw new UnsupportedModelProviderError(preferredProvider ?? 'unknown', `no client supports model "${model}"`);
  }

  listProviders() {
    return [...this.clients.keys()];
  }

  listClients() {
    return [...this.clients.values()];
  }
}

type ResponsePayload = ModelExecutionResponse & { usage: { input_tokens: number; output_tokens: number } };

/**
 * Sanitizes user-supplied text to prevent prompt injection attacks.
 *
 * Strips well-known injection patterns used to override system prompts:
 * - XML/HTML system tags: <system>, </system>
 * - Llama-style instruction markers: [INST], [/INST], <<SYS>>, <</SYS>>
 * - Common separator markers: ### System, --- System
 * - Null bytes and unusual control characters (excluding \n, \r, \t)
 *
 * This function does NOT strip regular content — it only removes tokens that
 * are structurally identical to known prompt injection vectors.
 */
function sanitizeUserContent(content: string): string {
  return content
    // Remove XML/HTML-style system/instruction tags
    .replace(/<\/?system\s*>/gi, '')
    .replace(/<\/?s>/gi, '')
    .replace(/<\/?SYS\s*>/gi, '')
    // Remove Llama/Mistral style tokens
    .replace(/\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>/gi, '')
    // Remove GPT-style role separator headers
    .replace(/^#{1,4}\s*(system|instruction|prompt)\s*:?\s*$/gim, '')
    .replace(/^-{3,}\s*(system|instruction|prompt)\s*-{3,}$/gim, '')
    // Strip null bytes and control characters (except \n \r \t)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

function sanitizeMessages(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  const sanitized = body.messages.map((msg: unknown) => {
    if (!msg || typeof msg !== 'object') return msg;
    const message = msg as Record<string, unknown>;
    if (message.role !== 'user') return message;
    if (typeof message.content === 'string') {
      return { ...message, content: sanitizeUserContent(message.content) };
    }
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((block: unknown) => {
          if (block && typeof block === 'object' && 'type' in block) {
            const typed = block as Record<string, unknown>;
            if (typed.type === 'text' && typeof typed.text === 'string') {
              return { ...typed, text: sanitizeUserContent(typed.text) };
            }
          }
          return block;
        }),
      };
    }
    return message;
  });
  return { ...body, messages: sanitized };
}

function mergeSystemInstruction(body: Record<string, unknown>, runtimeSummary: string, runtimePlan: string) {
  // Sanitize user messages to prevent prompt injection before merging system context.
  const sanitizedBody = sanitizeMessages(body);

  const injected = [
    '[AGENT RUNTIME]',
    'The runtime has already handled goal understanding, workspace initialization, repository analysis, context building, tool selection, planning, and tool governance.',
    `Runtime summary:\n${runtimeSummary}`,
    `Execution plan:\n${runtimePlan}`,
    'You are executing a runtime-owned plan. Use tool calls when needed and wait for tool results before continuing.',
  ].join('\n\n');

  if (typeof sanitizedBody?.system === 'string' && sanitizedBody.system.trim()) {
    return { ...sanitizedBody, system: `${injected}\n\n${sanitizedBody.system}` };
  }

  if (Array.isArray(sanitizedBody?.system)) {
    return { ...sanitizedBody, system: [{ type: 'text', text: injected }, ...sanitizedBody.system] };
  }

  return { ...sanitizedBody, system: injected };
}

function providerFromModel(model: string): ModelProviderName {
  return 'gemini';
}


class GeminiModelClient implements ModelClient {
  readonly provider = 'gemini' as const;

  supports() {
    return true;
  }

  async execute(request: ProviderExecutionRequest): Promise<ModelExecutionResponse> {
    request.cancellation?.throwIfCancelled();
    const toolIdMap = new Map<string, string>();
    const toolSchemas = new Map<string, ToolSchema>();
    const originalToolNames = new Map<string, string>();
    const body = mergeSystemInstruction(request.body, request.runtimeSummary, request.runtimePlan) as Record<string, unknown>;
    const { geminiBody, webSearchConfig, requestContext } = await transformRequestToGemini(
      body,
      toolIdMap,
      toolSchemas,
      request.internalModel,
      originalToolNames,
      request.token,
      request.requestId,
    );

    let geminiRes: Record<string, unknown>;
    if (webSearchConfig) {
      const keyObj = await getHealthiestKeyObj(request.token);
      const apiKey = keyObj?.key ?? '';
      geminiRes = await runWithWebSearch(geminiBody, {
        webSearchConfig,
        callGemini: (payload) => callGemini(request.internalModel, apiKey, payload, false),
      });
    } else {
      const response = await executeWithRetry(
        request.requestedModel,
        geminiBody,
        false,
        request.token,
        request.route,
        request.requestId,
        requestContext,
      );
      geminiRes = await response.json();
    }

    return {
      ...(await transformGeminiToAnthropic(
        geminiRes,
        request.requestedModel,
        toolIdMap,
        toolSchemas,
        originalToolNames,
        request.internalModel,
      )),
      provider: this.provider,
      model: request.internalModel,
    };
  }

  stream(request: ProviderExecutionRequest & {
    onError: (error: unknown) => void | Promise<void>;
    onComplete: (usage: StreamUsage) => void | Promise<void>;
  }) {
    const usageRef: StreamUsage = { inputTokens: 0, outputTokens: 0 };
    const body = mergeSystemInstruction(request.body, request.runtimeSummary, request.runtimePlan) as Record<string, unknown>;
    const transformIterator = transformStream(
      body,
      request.requestedModel,
      request.internalModel,
      request.token,
      usageRef,
      request.route,
      request.requestId,
    );

    let pingInterval: ReturnType<typeof setInterval> | null = null;
    let streamClosed = false;

    const streamBody = new ReadableStream({
      async start(controller) {
        const safeEnqueue = (chunk: Uint8Array) => {
          if (streamClosed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            streamClosed = true;
          }
        };

        pingInterval = setInterval(() => {
          safeEnqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'));
        }, 2000);

        try {
          for await (const chunk of transformIterator) {
            request.cancellation?.throwIfCancelled();
            safeEnqueue(new TextEncoder().encode(chunk));
          }
        } catch (error) {
          await request.onError(error);
          safeEnqueue(new TextEncoder().encode('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Stream failed"}}\n\n'));
        } finally {
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          streamClosed = true;
          try {
            controller.close();
          } catch {}
          await request.onComplete(usageRef);
        }
      },
      cancel() {
        streamClosed = true;
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
      },
    });

    return new Response(streamBody, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Anthropic-Version': '2023-06-01',
        'X-Request-Id': request.requestId,
      },
    });
  }
}

export class ProviderModelRuntime {
  private readonly registry = new ModelProviderRegistry();
  private readonly health = new Map<ModelProviderName, RuntimeProviderHealthSnapshot>();

  constructor(clients?: ModelClient[]) {
    const defaultClients = clients ?? [
      new GeminiModelClient(),
    ];
    for (const client of defaultClients) {
      this.registry.register(client);
    }
  }

  private resolveClients(request: ProviderExecutionRequest) {
    return this.registry.listClients();
  }

  private markHealth(provider: ModelProviderName, patch: Partial<RuntimeProviderHealthSnapshot>) {
    const previous = this.health.get(provider);
    this.health.set(provider, {
      provider: provider as ModelProvider,
      available: patch.available ?? previous?.available ?? true,
      failures: patch.failures ?? previous?.failures ?? 0,
      lastError: patch.lastError ?? previous?.lastError,
      latencyMs: patch.latencyMs ?? previous?.latencyMs,
      updatedAt: Date.now(),
    });
  }

  async execute(request: ProviderExecutionRequest) {
    // Basic cost optimization warnings / logic:
    // If the token budget is tight (< 6000), fall back to cheaper variants or verify usage
    if (request.route.estimatedInputTokens && request.route.estimatedInputTokens > 100_000) {
      console.warn(`[ModelRuntime] Extremely high context volume: ${request.route.estimatedInputTokens} input tokens. Pre-compressing context is advised.`);
    }

    const clients = this.resolveClients(request);
    let lastError: unknown = null;
    for (const client of clients) {
      const startedAt = Date.now();
      try {
        const response = await client.execute(request);
        this.markHealth(client.provider, { available: true, failures: 0, latencyMs: Date.now() - startedAt });
        return response;
      } catch (error) {
        lastError = error;
        const previous = this.health.get(client.provider);
        this.markHealth(client.provider, {
          available: false,
          failures: (previous?.failures ?? 0) + 1,
          lastError: error instanceof Error ? error.message : String(error),
          latencyMs: Date.now() - startedAt,
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'All providers failed'));
  }

  stream(request: ProviderExecutionRequest & {
    onError: (error: unknown) => void | Promise<void>;
    onComplete: (usage: StreamUsage) => void | Promise<void>;
  }) {
    const primary = this.resolveClients(request)[0];
    if (!primary?.stream) {
      throw new Error(`Streaming is not available for provider ${primary?.provider ?? 'unknown'}`);
    }
    return primary.stream(request);
  }

  healthSnapshot() {
    return Array.from(this.health.values());
  }

  static handleFailure(error: unknown) {
    const anthropicErr = transformError(error);
    return Response.json(anthropicErr, {
      status: anthropicErr.error.type === 'overloaded_error'
        ? 529
        : (typeof error === 'object' && error && 'status' in error && typeof (error as { status?: number }).status === 'number'
          ? (error as { status: number }).status
          : 500),
    });
  }

  static finalizeSuccess(options: {
    requestedModel: string;
    internalModel: string;
    route: ModelRoute;
    token: string;
    startedAt: number;
    response: ResponsePayload;
  }) {
    recordLatency(Date.now() - options.startedAt).catch(() => {});
    recordTokens(options.response.usage.input_tokens, options.response.usage.output_tokens, {
      model: options.requestedModel,
      userToken: options.token,
    }).catch(() => {});
    logRequest({
      model: options.requestedModel,
      resolvedModel: options.internalModel,
      routingSource: options.route.routingSource,
      routeVersion: options.route.routeVersion,
      taskType: options.route.taskType,
      taskReason: options.route.taskReason,
      stream: false,
      latency: Date.now() - options.startedAt,
      status: 200,
    });
    logActivity({
      ts: Date.now(),
      userKey: maskToken(options.token),
      model: options.requestedModel,
      geminiModel: options.internalModel,
      inputTokens: options.response.usage.input_tokens,
      outputTokens: options.response.usage.output_tokens,
      latencyMs: Date.now() - options.startedAt,
      retries: 0,
      status: 'success',
      streaming: false,
      fallback: options.route.primary !== options.internalModel,
      routingSource: options.route.routingSource,
      routeVersion: options.route.routeVersion,
      taskType: options.route.taskType,
      taskReason: options.route.taskReason,
      toolsUsed: (options.response.content ?? []).filter((block) => typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_use').length,
    }).catch(() => {});
  }

  static finalizeStreamSuccess(options: {
    requestedModel: string;
    internalModel: string;
    route: ModelRoute;
    token: string;
    startedAt: number;
    usage: StreamUsage;
  }) {
    recordLatency(Date.now() - options.startedAt).catch(() => {});
    recordTokens(options.usage.inputTokens, options.usage.outputTokens, {
      model: options.requestedModel,
      userToken: options.token,
    }).catch(() => {});
    logActivity({
      ts: Date.now(),
      userKey: maskToken(options.token),
      model: options.requestedModel,
      geminiModel: options.internalModel,
      inputTokens: options.usage.inputTokens,
      outputTokens: options.usage.outputTokens,
      latencyMs: Date.now() - options.startedAt,
      retries: 0,
      status: 'success',
      streaming: true,
      fallback: options.route.primary !== options.internalModel,
      toolsUsed: 0,
    }).catch(() => {});
  }

  static finalizeError(requestedModel: string, token: string, error: unknown) {
    incrementErrorCount({ model: requestedModel, userToken: token }).catch(() => {});
    return errorOneLiner(error, 'model-runtime');
  }
}
