import { stableHash } from '../utils/hash';
import type { EditFailureType } from './edit-failure-classifier';

export type PatchStrategy = 'AST_NODE' | 'DOM_SELECTOR' | 'EXACT_REPLACE';

const JS_TS_EXT = new Set(['js', 'ts', 'jsx', 'tsx']);

function getExt(filePath: string | null | undefined): string {
  if (!filePath) return '';
  const m = filePath.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function detectPatchStrategy(filePath: string | null | undefined): PatchStrategy {
  const ext = getExt(filePath);
  if (ext === 'html' || ext === 'htm') return 'DOM_SELECTOR';
  if (JS_TS_EXT.has(ext)) return 'AST_NODE';
  return 'EXACT_REPLACE';
}

export function buildStructureAwarePatchGuidance(
  filePath: string | null | undefined,
  failureType: EditFailureType,
): string {
  const strategy = detectPatchStrategy(filePath);
  const fileRef = filePath || 'the target file';

  if (strategy === 'DOM_SELECTOR') {
    return [
      `• HTML specialization: patch ${fileRef} by stable DOM selectors (id/class/tag scope), not raw block matching.`,
      '• Prefer selector-targeted edits (e.g., `#id`, `.class`) and update only the matched node.',
      `• Failure observed (${failureType}) indicates fragile raw matching; switch to selector-based targeting now.`,
    ].join('\n');
  }

  if (strategy === 'AST_NODE') {
    return [
      `• JS/TS structure-aware patching: target function/node scope in ${fileRef} rather than long exact old_string blocks.`,
      '• Prefer function-level edits (imports, declaration body, return node) and keep each patch narrowly scoped.',
      `• Failure observed (${failureType}) indicates exact-string brittleness; switch to node-level targeting now.`,
    ].join('\n');
  }

  return '• Fallback: exact replace is acceptable for non-JS/HTML files when scoped and unique.';
}

export function hashFileSnapshot(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return stableHash(normalized);
}

export function buildFreshSnapshotGuidance(
  filePath: string | null | undefined,
  snapshotHash: string | null | undefined,
): string {
  const fileRef = filePath || 'the target file';
  const hashText = snapshotHash ? ` hash=${snapshotHash.slice(0, 12)}` : '';
  return [
    `• Fresh snapshot required for ${fileRef}: re-read immediately before retrying the edit.${hashText}`,
    '• Verify snapshot freshness by content hash; do not reuse stale cached content.',
  ].join('\n');
}
