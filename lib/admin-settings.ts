import { redis } from './redis';

const ADMIN_SYSTEM_SETTINGS_KEY = 'admin:system:settings';

export interface AdminSystemSettings {
  racingEnabled: boolean;
}

const DEFAULT_SETTINGS: AdminSystemSettings = {
  racingEnabled: false,
};

let settingsCache: AdminSystemSettings = { ...DEFAULT_SETTINGS };
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5_000;

function normalizeSettings(input: unknown): AdminSystemSettings {
  if (!input || typeof input !== 'object') return { ...DEFAULT_SETTINGS };
  const value = input as Record<string, unknown>;
  return {
    racingEnabled: value.racingEnabled === true,
  };
}

async function readSettingsFromRedis(): Promise<AdminSystemSettings> {
  const raw = await redis.get<string>(ADMIN_SYSTEM_SETTINGS_KEY).catch(() => null);
  if (!raw) return { ...DEFAULT_SETTINGS };

  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return normalizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function getAdminSystemSettings(forceReload = false): Promise<AdminSystemSettings> {
  if (!forceReload && Date.now() - cacheLoadedAt < CACHE_TTL_MS) {
    return settingsCache;
  }

  settingsCache = await readSettingsFromRedis();
  cacheLoadedAt = Date.now();
  return settingsCache;
}

export function getCachedAdminSystemSettings(): AdminSystemSettings {
  return settingsCache;
}

export async function updateAdminSystemSettings(
  updates: Partial<AdminSystemSettings>
): Promise<AdminSystemSettings> {
  const current = await getAdminSystemSettings(true);
  const next = normalizeSettings({ ...current, ...updates });
  await redis.set(ADMIN_SYSTEM_SETTINGS_KEY, JSON.stringify(next));
  settingsCache = next;
  cacheLoadedAt = Date.now();
  return next;
}
