import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redis } from './redis';
import { classifyTaskType, getTaskModelChain, type TaskType } from './routing/task-router';

export interface ModelRoute {
  primary: string;
  fallback: string[];
  profile?: 'simple' | 'balanced' | 'complex' | 'agentic';
  reason?: string;
  estimatedInputTokens?: number;
  routingSource?: 'redis' | 'local' | 'hardcoded';
  taskType?: TaskType;
  taskReason?: string;
  routeVersion?: string;
}

export interface ModelRoutingOptions {
  thinkingEnabled?: boolean;
  requestBody?: any;
  userId?: string;
}

export const ROUTING_REGISTRY_KEY = 'models:registry';
export const ROUTING_REGISTRY_VERSION_KEY = 'models:registry:version';
export const ROUTING_REGISTRY_UPDATED_AT_KEY = 'models:registry:updatedAt';

// Final emergency fallback if Redis + local JSON are both unavailable.
export const HARD_DEFAULT_MODEL_ROUTING: Record<string, ModelRoute> = {
  'claude-opus-4-5': { primary: 'gemini-2.5-flash', fallback: ['gemini-3-flash-preview', 'gemma-4-31b-it'] },
  'claude-opus-4': { primary: 'gemini-2.5-flash', fallback: ['gemini-3-flash-preview', 'gemma-4-31b-it'] },
  'claude-4-opus': { primary: 'gemini-2.5-flash', fallback: ['gemini-3-flash-preview', 'gemma-4-31b-it'] },
  'claude-sonnet-4-6': { primary: 'gemini-2.5-flash', fallback: ['gemini-3.1-flash-lite-preview', 'gemini-flash-latest'] },
  'claude-sonnet-4-5': { primary: 'gemini-2.5-flash', fallback: ['gemini-3.1-flash-lite-preview', 'gemini-flash-latest'] },
  'claude-4-sonnet': { primary: 'gemini-2.5-flash', fallback: ['gemini-3.1-flash-lite-preview', 'gemini-flash-latest'] },
  'claude-haiku-4-5': { primary: 'gemini-2.5-flash-lite', fallback: ['gemini-flash-lite-latest', 'gemini-flash-latest'] },
  'claude-4-haiku': { primary: 'gemini-2.5-flash-lite', fallback: ['gemini-flash-lite-latest', 'gemini-flash-latest'] },
  'claude-3-7-sonnet': { primary: 'gemini-2.5-flash', fallback: ['gemini-3.1-flash-lite-preview', 'gemini-flash-latest'] },
  'claude-3-5-sonnet': { primary: 'gemini-2.5-flash', fallback: ['gemini-3.1-flash-lite-preview', 'gemini-flash-latest'] },
  'claude-3-5-haiku': { primary: 'gemini-2.5-flash-lite', fallback: ['gemini-flash-lite-latest', 'gemini-flash-latest'] },
  'claude-3-opus': { primary: 'gemini-2.5-flash', fallback: ['gemini-3-flash-preview', 'gemma-4-31b-it'] },
  'claude-3-haiku': { primary: 'gemini-2.5-flash-lite', fallback: ['gemini-flash-lite-latest', 'gemini-flash-latest'] },

  // Direct mappings
  'gemma-4-31b-it': { primary: 'gemma-4-31b-it', fallback: ['gemma-4-26b-a4b-it', 'gemini-2.5-flash'] },
  'gemma-4-26b-a4b-it': { primary: 'gemma-4-26b-a4b-it', fallback: ['gemma-4-31b-it', 'gemini-2.5-flash'] },
  'gemini-2.5-flash': { primary: 'gemini-2.5-flash', fallback: ['gemini-3-flash-preview', 'gemini-flash-latest'] },
  'gemini-2.5-flash-lite': { primary: 'gemini-2.5-flash-lite', fallback: ['gemini-flash-lite-latest', 'gemini-flash-latest'] },
  'gemini-3-flash-preview': { primary: 'gemini-3-flash-preview', fallback: ['gemini-2.5-flash', 'gemini-flash-latest'] },
  'gemini-3.1-flash-lite-preview': { primary: 'gemini-3.1-flash-lite-preview', fallback: ['gemini-2.5-flash', 'gemini-flash-latest'] },
  'gemini-flash-lite-latest': { primary: 'gemini-flash-lite-latest', fallback: ['gemini-2.5-flash-lite'] },
  'gemini-flash-latest': { primary: 'gemini-flash-latest', fallback: ['gemini-2.5-flash'] },
};

export const DEFAULT_MODEL_ROUTING = HARD_DEFAULT_MODEL_ROUTING;

interface RoutingRegistryCache {
  version: string;
  source: 'redis' | 'local' | 'hardcoded';
  loadedAt: number;
  registry: Record<string, ModelRoute>;
}

interface RoutingReadResult {
  registry: Record<string, ModelRoute>;
  source: 'redis' | 'local' | 'hardcoded';
  version: string;
}

interface RoutingDiagnostics {
  source: 'redis' | 'local' | 'hardcoded';
  version: string;
  aliases: number;
  loadedAt: number;
}

interface RedisLike {
  get<T = string>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<void>;
  incr(key: string): Promise<number>;
}

let redisClient: RedisLike = redis;
let registryCache: RoutingRegistryCache | null = null;
let localRegistryCache: Record<string, ModelRoute> | null = null;

function normalizeModelName(rawModel: string): string {
  if (!rawModel) return rawModel;
  return rawModel.trim().toLowerCase();
}

function dedupeChain(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of models) {
    const normalized = normalizeModelName(model);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function toSafeRoute(value: any): ModelRoute | null {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.primary !== 'string' || !value.primary.trim()) return null;
  const fallback = Array.isArray(value.fallback)
    ? value.fallback.filter((m: unknown) => typeof m === 'string')
    : [];

  return {
    primary: normalizeModelName(value.primary),
    fallback: dedupeChain(fallback as string[]),
  };
}

function sanitizeRegistry(input: unknown): Record<string, ModelRoute> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, ModelRoute> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const route = toSafeRoute(value);
    if (!route) continue;
    out[normalizeModelName(key)] = route;
  }
  return out;
}

async function loadLocalDefaultRegistry(): Promise<Record<string, ModelRoute> | null> {
  if (localRegistryCache) return localRegistryCache;

  try {
    const filePath = path.join(process.cwd(), 'lib', 'routing', 'default-model-routing.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const sanitized = sanitizeRegistry(parsed);
    if (Object.keys(sanitized).length === 0) return null;
    localRegistryCache = sanitized;
    return sanitized;
  } catch {
    return null;
  }
}

async function readRegistry(forceReload = false): Promise<RoutingReadResult> {
  if (!forceReload && registryCache) {
    const currentVersion = await redisClient.get<string>(ROUTING_REGISTRY_VERSION_KEY).catch(() => null);
    const normalizedCurrent = (currentVersion ?? '0').toString();
    if (normalizedCurrent === registryCache.version) {
      return {
        registry: registryCache.registry,
        source: registryCache.source,
        version: registryCache.version,
      };
    }
  }

  const [registryRaw, versionRaw] = await Promise.all([
    redisClient.get<string>(ROUTING_REGISTRY_KEY).catch(() => null),
    redisClient.get<string>(ROUTING_REGISTRY_VERSION_KEY).catch(() => null),
  ]);

  const version = (versionRaw ?? '0').toString();

  let redisRegistry: Record<string, ModelRoute> | null = null;
  if (registryRaw) {
    try {
      const parsed = typeof registryRaw === 'string' ? JSON.parse(registryRaw) : registryRaw;
      const sanitized = sanitizeRegistry(parsed);
      if (Object.keys(sanitized).length > 0) redisRegistry = sanitized;
    } catch {
      redisRegistry = null;
    }
  }

  const localRegistry = await loadLocalDefaultRegistry();
  const hardcoded = sanitizeRegistry(HARD_DEFAULT_MODEL_ROUTING);

  let source: 'redis' | 'local' | 'hardcoded' = 'hardcoded';
  let registry: Record<string, ModelRoute> = hardcoded;

  if (localRegistry && Object.keys(localRegistry).length > 0) {
    source = 'local';
    registry = { ...hardcoded, ...localRegistry };
  }

  if (redisRegistry) {
    source = 'redis';
    registry = { ...registry, ...redisRegistry };
  }

  registryCache = {
    version,
    source,
    loadedAt: Date.now(),
    registry,
  };

  return { registry, source, version };
}

function resolveGlobalDefaultRoute(): ModelRoute {
  const fallbackRaw = process.env.FALLBACK_MODEL || 'gemini-2.5-flash';
  const fallback = fallbackRaw.includes(',')
    ? fallbackRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [fallbackRaw];
  return {
    primary: process.env.DEFAULT_MODEL || 'gemini-2.5-flash',
    fallback,
  };
}

function resolveBaseRoute(
  normalizedModel: string,
  registry: Record<string, ModelRoute>
): ModelRoute {
  if (registry[normalizedModel]) {
    return {
      primary: normalizeModelName(registry[normalizedModel].primary),
      fallback: dedupeChain(registry[normalizedModel].fallback || []),
    };
  }

  for (const [key, value] of Object.entries(registry)) {
    if (normalizedModel.startsWith(normalizeModelName(key))) {
      return {
        primary: normalizeModelName(value.primary),
        fallback: dedupeChain(value.fallback || []),
      };
    }
  }

  if (normalizedModel.startsWith('claude-')) {
    return {
      primary: 'gemini-2.5-flash',
      fallback: ['gemini-3.1-flash-lite-preview', 'gemini-flash-latest'],
    };
  }

  return resolveGlobalDefaultRoute();
}

export function buildStickyRouteKey(userId: string, anthropicModel: string, routeVersion = '0'): string {
  return `route:last:v${routeVersion}:${userId}:${normalizeModelName(anthropicModel)}`;
}

export async function forceReloadRouting(): Promise<RoutingDiagnostics> {
  registryCache = null;
  const loaded = await readRegistry(true);
  return {
    source: loaded.source,
    version: loaded.version,
    aliases: Object.keys(loaded.registry).length,
    loadedAt: Date.now(),
  };
}

export async function getRoutingDiagnostics(): Promise<RoutingDiagnostics> {
  const loaded = await readRegistry(false);
  return {
    source: loaded.source,
    version: loaded.version,
    aliases: Object.keys(loaded.registry).length,
    loadedAt: registryCache?.loadedAt ?? Date.now(),
  };
}

export async function getEffectiveRoutingRegistry(): Promise<Record<string, ModelRoute>> {
  const loaded = await readRegistry(false);
  return loaded.registry;
}

/** Public alias — single stable name for external consumers. */
export const getRoutingRegistry = getEffectiveRoutingRegistry;

export async function saveRoutingRegistry(models: unknown): Promise<RoutingDiagnostics> {
  const sanitized = sanitizeRegistry(models);
  await redisClient.set(ROUTING_REGISTRY_KEY, JSON.stringify(sanitized));
  await redisClient.incr(ROUTING_REGISTRY_VERSION_KEY).catch(async () => {
    await redisClient.set(ROUTING_REGISTRY_VERSION_KEY, '1');
    return 1;
  });
  await redisClient.set(ROUTING_REGISTRY_UPDATED_AT_KEY, new Date().toISOString()).catch(() => {});

  return forceReloadRouting();
}

export async function getModelMapping(
  anthropicModel: string,
  optionsOrThinking: boolean | ModelRoutingOptions = false
): Promise<ModelRoute> {
  const options: ModelRoutingOptions =
    typeof optionsOrThinking === 'boolean'
      ? { thinkingEnabled: optionsOrThinking }
      : optionsOrThinking;

  const normalizedModel = normalizeModelName(anthropicModel);
  const thinkingEnabled = Boolean(options.thinkingEnabled);

  const loaded = await readRegistry(false);
  const baseRoute = resolveBaseRoute(normalizedModel, loaded.registry);

  if (!normalizedModel.startsWith('claude-')) {
    const chain = dedupeChain([baseRoute.primary, ...baseRoute.fallback]);
    return {
      primary: chain[0] || resolveGlobalDefaultRoute().primary,
      fallback: chain.slice(1),
      routingSource: loaded.source,
      routeVersion: loaded.version,
      taskType: 'LIGHT_CODING',
      taskReason: 'direct-model-routing',
    };
  }

  const task = classifyTaskType(options.requestBody, thinkingEnabled);
  const taskChain = getTaskModelChain(task.type);

  let stickyModel = '';
  if (options.userId) {
    const stickyKey = buildStickyRouteKey(options.userId, normalizedModel, loaded.version);
    const stickyRaw = await redisClient.get<string>(stickyKey).catch(() => null);
    if (typeof stickyRaw === 'string' && stickyRaw.trim()) {
      stickyModel = normalizeModelName(stickyRaw);
    }
  }

  const taskFirst = task.type === 'REASONING' || task.type === 'COMPACTION';

  // Source-of-truth priority:
  // Redis/local/hardcoded configured route remains first for normal traffic.
  // Reasoning/compaction tasks may prioritize Gemma chain first.
  const finalChain = taskFirst
    ? dedupeChain([
        ...taskChain,
        baseRoute.primary,
        ...baseRoute.fallback,
        stickyModel,
        ...resolveGlobalDefaultRoute().fallback,
      ])
    : dedupeChain([
        baseRoute.primary,
        ...baseRoute.fallback,
        ...taskChain,
        stickyModel,
        ...resolveGlobalDefaultRoute().fallback,
      ]);

  return {
    primary: finalChain[0] || baseRoute.primary,
    fallback: finalChain.slice(1),
    routingSource: loaded.source,
    taskType: task.type,
    taskReason: task.reason,
    routeVersion: loaded.version,
  };
}

export async function __setRoutingTestAdapters(adapters: {
  redisClient?: RedisLike;
  localRegistry?: Record<string, ModelRoute> | null;
}): Promise<void> {
  if (adapters.redisClient) redisClient = adapters.redisClient;
  if (adapters.localRegistry !== undefined) localRegistryCache = adapters.localRegistry;
  registryCache = null;
}

export async function __resetRoutingTestAdapters(): Promise<void> {
  redisClient = redis;
  localRegistryCache = null;
  registryCache = null;
}
