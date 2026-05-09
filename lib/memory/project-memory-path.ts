/**
 * lib/memory/project-memory-path.ts
 *
 * Canonical path generation for .coatcard memory directories.
 *
 * RULE: .coatcard/ belongs in the ACTIVE TARGET PROJECT root — NEVER the
 * gateway root.  The gateway stores shared runtime state in Redis.
 * Project-scoped embeddings, summaries, and hashes live in the project's
 * own workspace.
 *
 * Detection order:
 *   1. Explicit WORKSPACE_ROOT env var
 *   2. COATCARD_PROJECT_ROOT env var (legacy alias)
 *   3. Fallback: process.cwd() (dev-only — logs a warning)
 */

import * as path from 'path';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace root for the active target project.
 *
 * This MUST NOT return the gateway's own root in production.
 */
export function getWorkspaceRoot(): string {
  const explicit = process.env.WORKSPACE_ROOT || process.env.COATCARD_PROJECT_ROOT;
  if (explicit) return path.resolve(explicit);

  // Dev-only fallback — acceptable during local testing
  if (process.env.NODE_ENV !== 'production') {
    return process.cwd();
  }

  console.warn(
    '[project-memory-path] WORKSPACE_ROOT not set in production — falling back to cwd. ' +
      'Set WORKSPACE_ROOT to the target project root.',
  );
  return process.cwd();
}

// ---------------------------------------------------------------------------
// .coatcard sub-paths
// ---------------------------------------------------------------------------

/** Root of the .coatcard directory inside the workspace. */
export function getCoatcardPath(): string {
  return path.join(getWorkspaceRoot(), '.coatcard');
}

/** Path for the retrieval-index vectors cache. */
export function getEmbeddingsPath(): string {
  return path.join(getCoatcardPath(), 'retrieval-index');
}

/** Path for summary JSON files. */
export function getSummariesPath(): string {
  return path.join(getCoatcardPath(), 'summaries');
}

/** Path for artifacts (file hashes, etc.). */
export function getArtifactsPath(): string {
  return path.join(getCoatcardPath(), 'artifacts');
}

/** Path for task graph data. */
export function getTaskGraphPath(): string {
  return path.join(getCoatcardPath(), 'task-graph');
}

// ---------------------------------------------------------------------------
// Full file-paths used by other modules
// ---------------------------------------------------------------------------

export function getVectorsFilePath(): string {
  return path.join(getEmbeddingsPath(), 'vectors.json');
}

export function getSummariesFilePath(): string {
  return path.join(getSummariesPath(), 'summaries.json');
}

export function getFileHashesPath(): string {
  return path.join(getArtifactsPath(), 'file-hashes.json');
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/**
 * Whether the local .coatcard disk cache is enabled.
 * Default: true in dev, false in production.
 */
export function isLocalCacheEnabled(): boolean {
  const env = process.env.ENABLE_LOCAL_MEMORY_CACHE;
  if (env !== undefined) return env === 'true';
  return process.env.NODE_ENV !== 'production';
}

/**
 * Workspace identifier for scoping Redis keys so projects don't
 * contaminate each other.
 */
export function getWorkspaceId(): string {
  const explicit = process.env.WORKSPACE_ID;
  if (explicit) return explicit;
  // Derive from the workspace root (last two path segments)
  const root = getWorkspaceRoot();
  const parts = root.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}
