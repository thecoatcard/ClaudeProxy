// PathGuard — inspect tool_use inputs for path-shaped strings and detect problems.
//
// The gateway cannot access the filesystem, so "validate path exists" is not
// possible here. What we CAN do is detect path strings that are structurally
// wrong BEFORE they reach the model: directory traversal attempts, mixed
// OS separators, empty paths, null bytes, and paths that don't match the
// task's expected working root.
//
// Pure functions, no I/O, edge-runtime safe.

export type PathIssueKind =
  | 'traversal'          // contains ../  (could escape intended root)
  | 'mixed_separators'   // both / and \ (common Windows/Linux confusion)
  | 'empty'              // empty or whitespace-only path
  | 'null_byte'          // null byte injection attempt
  | 'absolute_unexpected' // absolute path when a relative one was expected
  | 'suspicious_chars';  // shell metacharacters inside a path value

export interface PathIssue {
  paramKey: string;
  path: string;
  kind: PathIssueKind;
  description: string;
}

// Characters that shouldn't appear in bare file paths (they should be in args, not path).
const SHELL_META = /[;&|`$<>!*?{}[\]()]/;

function checkPath(key: string, rawPath: string): PathIssue[] {
  const issues: PathIssue[] = [];
  const path = rawPath.trim();

  if (!path) {
    issues.push({ paramKey: key, path: rawPath, kind: 'empty', description: `Path parameter '${key}' is empty or whitespace.` });
    return issues; // no further checks on empty
  }

  if (path.includes('\0')) {
    issues.push({ paramKey: key, path, kind: 'null_byte', description: `Path '${key}' contains a null byte — possible injection attempt.` });
  }

  // Detect directory traversal: look for ../ or ..\ anywhere in the path.
  if (/\.\.[/\\]/.test(path) || path === '..') {
    issues.push({ paramKey: key, path, kind: 'traversal', description: `Path '${key}' contains a parent-directory traversal sequence ('..').` });
  }

  // Mixed separators (/ and \ both present) — usually a Windows-vs-Linux confusion.
  if (path.includes('/') && path.includes('\\')) {
    issues.push({ paramKey: key, path, kind: 'mixed_separators', description: `Path '${key}' mixes forward slashes and backslashes — normalize to one separator style.` });
  }

  // Shell metacharacters inside what should be a plain path.
  if (SHELL_META.test(path)) {
    issues.push({ paramKey: key, path, kind: 'suspicious_chars', description: `Path '${key}' contains shell metacharacters. If this is a path, strip them; if you need shell expansion, use a Bash tool instead.` });
  }

  return issues;
}

// Keys in tool inputs that are likely to hold file paths.
const PATH_KEYS = new Set([
  'path', 'file', 'filename', 'filepath', 'file_path', 'directory',
  'dir', 'destination', 'source', 'src', 'dest', 'target', 'output',
  'input', 'from', 'to', 'cwd', 'working_directory',
]);

/** Walk a tool_use input object and extract path issues from known path-like keys. */
export function inspectToolInputPaths(toolName: string, input: any): PathIssue[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];

  const issues: PathIssue[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;

    // Always check keys that are known path params.
    if (PATH_KEYS.has(key.toLowerCase())) {
      issues.push(...checkPath(key, value));
      continue;
    }

    // Heuristic: string values that look like paths but aren't in known keys.
    // Only fire if the value strongly resembles a path (starts with ./ or / or ~).
    if (/^[./~]/.test(value.trim()) && value.trim().length > 1) {
      issues.push(...checkPath(key, value));
    }
  }

  return issues;
}

/** Walk all tool_use blocks in the full message history and return all path issues. */
export function inspectHistoryPaths(messages: any[]): PathIssue[] {
  const allIssues: PathIssue[] = [];
  for (const msg of messages || []) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_use') continue;
      allIssues.push(...inspectToolInputPaths(block.name, block.input));
    }
  }
  return allIssues;
}

/** Build a guidance fragment from path issues. Returns '' if none. */
export function buildPathGuidance(issues: PathIssue[]): string {
  if (issues.length === 0) return '';

  const lines = [
    '---',
    `[PATH] ${issues.length} path issue(s): ${issues.map(i => i.description).join('; ')}`,
    '• No mixed slashes. No ../. No empty paths. Keep shell metacharacters out of path fields.',
    '---',
  ];

  return lines.join('\n');
}
