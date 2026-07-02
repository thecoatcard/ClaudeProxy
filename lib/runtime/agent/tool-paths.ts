import path from 'node:path';

export function resolveWorkspacePath(workspaceRoot: string, target: string) {
  const resolved = path.resolve(workspaceRoot, target);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${target}`);
  }
  return resolved;
}

