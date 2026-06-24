// lib/agent/artifact-verifier.ts
//
// Artifact existence verifier — prevents the model from assuming a file/directory
// exists without evidence from a prior tool result.
//
// Edge-runtime safe. No filesystem I/O. Pure inference from OperationalState.
//
// Problems solved:
//   - Model writes to a file before creating it.
//   - Model "cd"s into a directory it hasn't created yet.
//   - Model builds from an artifact that a background task hasn't generated yet.

import type { OperationalState, ArtifactRecord } from '../context/operational-state';

export type ArtifactConfidence = 'verified' | 'uncertain' | 'likely_missing' | 'unknown';

export interface ArtifactVerification {
  path: string;
  confidence: ArtifactConfidence;
  lastSeen: string | null;
  /** Guidance to inject when confidence < 'verified'. Empty when verified. */
  guidance: string;
  /** Suggested verification tool call (e.g. list the parent directory). */
  verifyAction: string | null;
}

// Max age before a "verified" artifact becomes "uncertain" (30 minutes in ms).
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

function ageMs(isoDate: string): number {
  return Date.now() - new Date(isoDate).getTime();
}

/**
 * Evaluate a single path against the operational state.
 *
 * @param path     The path string the model is about to use.
 * @param state    Current operational state (loaded from Redis).
 * @param intent   Human-readable intent, e.g. "write a file to", "cd into".
 */
export function verifyArtifact(
  path: string,
  state: OperationalState,
  intent = 'access',
): ArtifactVerification {
  const record: ArtifactRecord | undefined = state.known_artifacts[path];
  const now = Date.now();

  // ── Confirmed missing ────────────────────────────────────────────────────────
  if (record?.status === 'missing') {
    return {
      path,
      confidence: 'likely_missing',
      lastSeen: record.lastSeen,
      guidance: `STOP: '${path}' was confirmed MISSING by a prior tool result. Do NOT ${intent} this path without first creating it or verifying its current state.`,
      verifyAction: `List the parent directory to check whether '${path}' now exists.`,
    };
  }

  // ── Known failed create ──────────────────────────────────────────────────────
  if (record?.status === 'failed_create') {
    return {
      path,
      confidence: 'likely_missing',
      lastSeen: record.lastSeen,
      guidance: `STOP: A previous attempt to create '${path}' FAILED. Do NOT ${intent} this path. Diagnose the creation failure first.`,
      verifyAction: null,
    };
  }

  // ── Verified and fresh ───────────────────────────────────────────────────────
  if (record?.status === 'exists' && ageMs(record.lastSeen) < STALE_THRESHOLD_MS) {
    return {
      path,
      confidence: 'verified',
      lastSeen: record.lastSeen,
      guidance: '',
      verifyAction: null,
    };
  }

  // ── Verified but stale ───────────────────────────────────────────────────────
  if (record?.status === 'exists') {
    return {
      path,
      confidence: 'uncertain',
      lastSeen: record.lastSeen,
      guidance: `'${path}' was confirmed as existing but the evidence is older than 30 minutes. Verify it still exists before using it.`,
      verifyAction: `List the parent directory or read a file inside '${path}' to confirm it is still present.`,
    };
  }

  // ── Also check known_directories ────────────────────────────────────────────
  if ((state.known_directories ?? []).some(d => d === path || path.startsWith(d + '/') || path.startsWith(d + '\\'))) {
    return {
      path,
      confidence: 'uncertain',
      lastSeen: null,
      guidance: `'${path}' is inside a known directory, but the file itself has no existence evidence. Confirm the specific file exists before ${intent}ing it.`,
      verifyAction: `List the directory that should contain '${path}'.`,
    };
  }

  // ── No evidence at all ───────────────────────────────────────────────────────
  return {
    path,
    confidence: 'unknown',
    lastSeen: null,
    guidance: `No tool evidence that '${path}' exists. Before ${intent}ing it, either create it first or list the parent directory to confirm.`,
    verifyAction: `List the parent directory of '${path}' to check whether it exists.`,
  };
}

/**
 * Scan a batch of paths and build a combined guidance block.
 * Returns empty string when all paths are verified.
 */
export function buildVerificationGuidance(
  paths: Array<{ path: string; intent?: string }>,
  state: OperationalState,
): string {
  if (paths.length === 0) return '';

  const issues: ArtifactVerification[] = [];
  for (const { path, intent } of paths) {
    const v = verifyArtifact(path, state, intent ?? 'access');
    if (v.confidence !== 'verified') issues.push(v);
  }

  if (issues.length === 0) return '';

  const lines: string[] = [
    '',
    '[ARTIFACT VERIFICATION WARNINGS]',
  ];

  for (const issue of issues) {
    lines.push(`  • ${issue.guidance}`);
    if (issue.verifyAction) lines.push(`    Action: ${issue.verifyAction}`);
  }

  lines.push('Resolve uncertainty before proceeding with writes or builds.');
  return lines.join('\n');
}

/**
 * Extract paths from a tool_use input that need pre-operation verification.
 * Returns an array of { path, intent } objects.
 */
export function extractPathsForVerification(
  toolName: string,
  toolInput: any,
): Array<{ path: string; intent: string }> {
  const results: Array<{ path: string; intent: string }> = [];
  if (!toolInput || typeof toolInput !== 'object') return results;

  const isWrite = /write|create|edit|str_replace|append/i.test(toolName);
  const isRead = /read|cat|get/i.test(toolName);
  const isBuild = /build|compile|run|exec/i.test(toolName);
  const isNavigate = /cd|chdir/i.test(toolName);

  const pathFields = ['path', 'file_path', 'filePath', 'target', 'destination', 'dir', 'directory'];
  for (const field of pathFields) {
    if (typeof toolInput[field] === 'string' && toolInput[field].trim()) {
      const intent = isWrite ? 'write to'
        : isRead ? 'read from'
        : isBuild ? 'build from'
        : isNavigate ? 'cd into'
        : 'access';
      results.push({ path: toolInput[field].trim(), intent });
    }
  }

  return results;
}
