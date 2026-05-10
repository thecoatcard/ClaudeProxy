/**
 * lib/memory/file-ingestion.ts
 *
 * Scans the project for source files, docs, configs, and schema files.
 * Feeds them into the embedding engine for vector indexing.
 *
 * Filesystem access is OPTIONAL — gracefully skips scanning when
 * the runtime doesn't support it (e.g. Edge, serverless).
 * File scanning always targets workspace_root, NEVER gateway root.
 */

import * as path from 'path';
import { getWorkspaceRoot } from './project-memory-path';

// ---------------------------------------------------------------------------
// Filesystem capability detection
// ---------------------------------------------------------------------------

let _fsModule: typeof import('fs') | null = null;

function getFs(): typeof import('fs') | null {
  if (_fsModule !== null) return _fsModule;
  try {
    _fsModule = require('fs');
    return _fsModule;
  } catch {
    return null;
  }
}

/**
 * Check whether the current runtime supports filesystem operations.
 * Returns false in Edge runtime, serverless without fs, etc.
 */
export function supportsFileIngestion(): boolean {
  const fs = getFs();
  if (!fs) return false;
  try {
    // Probe with a lightweight existsSync call
    fs.existsSync('.');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Directories to scan for source files */
const INCLUDE_DIRS = ['src', 'app', 'components', 'lib', 'prisma', 'docs'];

/** Patterns to ignore */
const IGNORE_PATTERNS = [
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.git',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.coatcard',
];

/** File extensions to include */
const INCLUDE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs',
  '.json', '.md', '.mdx',
  '.css', '.scss',
  '.prisma', '.graphql', '.gql',
  '.yaml', '.yml', '.toml',
  '.env.example',
]);

/** Max file size to embed (500KB) */
const MAX_FILE_SIZE = 500_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileEntry {
  /** Relative path from project root */
  relativePath: string;
  /** Absolute path */
  absolutePath: string;
  /** File content */
  content: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  mtime: number;
  /** File extension */
  extension: string;
}

export interface IngestionResult {
  /** Files successfully read */
  files: FileEntry[];
  /** Files skipped (too large, binary, etc.) */
  skipped: string[];
  /** Total bytes ingested */
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Scan the project and return all eligible files for embedding.
 * Uses workspace root (not gateway root) as the base directory.
 * Returns empty result if filesystem is not available.
 *
 * @param projectRoot - Absolute path to the project root (defaults to workspace root)
 * @param extraDirs - Additional directories to scan beyond defaults
 */
export function scanProjectFiles(
  projectRoot?: string,
  extraDirs?: string[]
): IngestionResult {
  if (!supportsFileIngestion()) {
    console.info('[FileIngestion] Filesystem not available — skipping scan');
    return { files: [], skipped: [], totalBytes: 0 };
  }

  const root = projectRoot ?? getWorkspaceRoot();
  const fs = getFs()!;
  const dirs = [...INCLUDE_DIRS, ...(extraDirs ?? [])];
  const files: FileEntry[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  // Also scan root-level config files
  scanRootConfigs(root, files, skipped);

  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    if (!fs.existsSync(dirPath)) continue;
    walkDir(root, dirPath, files, skipped);
  }

  totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  return { files, skipped, totalBytes };
}

/**
 * Check if a file should be ignored.
 */
export function shouldIgnore(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return IGNORE_PATTERNS.some(
    (pat) => normalized.includes(`/${pat}/`) || normalized.includes(`/${pat}`) || normalized.startsWith(`${pat}/`)
  );
}

/** Lock/generated files that should never be embedded (even if extension is eligible) */
const LOCK_FILE_PATTERNS = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock'];

/**
 * Check if a file extension is eligible for embedding.
 */
export function isEligibleExtension(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (LOCK_FILE_PATTERNS.includes(basename)) return false;
  const ext = path.extname(filePath).toLowerCase();
  return INCLUDE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function walkDir(
  projectRoot: string,
  dirPath: string,
  files: FileEntry[],
  skipped: string[]
): void {
  const fs = getFs();
  if (!fs) return;

  let entries: import('fs').Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(projectRoot, fullPath);

    if (shouldIgnore(relativePath)) continue;

    if (entry.isDirectory()) {
      walkDir(projectRoot, fullPath, files, skipped);
    } else if (entry.isFile()) {
      processFile(projectRoot, fullPath, relativePath, files, skipped);
    }
  }
}

function processFile(
  _projectRoot: string,
  fullPath: string,
  relativePath: string,
  files: FileEntry[],
  skipped: string[]
): void {
  const fs = getFs();
  if (!fs) return;

  if (!isEligibleExtension(fullPath)) {
    skipped.push(relativePath);
    return;
  }

  let stat: import('fs').Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    skipped.push(relativePath);
    return;
  }

  if (stat.size > MAX_FILE_SIZE) {
    skipped.push(relativePath);
    return;
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    files.push({
      relativePath: relativePath.replace(/\\/g, '/'),
      absolutePath: fullPath,
      content,
      size: stat.size,
      mtime: stat.mtimeMs,
      extension: path.extname(fullPath).toLowerCase(),
    });
  } catch {
    skipped.push(relativePath);
  }
}

function scanRootConfigs(
  projectRoot: string,
  files: FileEntry[],
  skipped: string[]
): void {
  const fs = getFs();
  if (!fs) return;

  const rootFiles = [
    'package.json',
    'tsconfig.json',
    'next.config.ts',
    'jest.config.ts',
    'eslint.config.mjs',
  ];

  for (const name of rootFiles) {
    const fullPath = path.join(projectRoot, name);
    if (fs.existsSync(fullPath)) {
      processFile(projectRoot, fullPath, name, files, skipped);
    }
  }
}

/**
 * Chunk a file's content into segments suitable for embedding.
 * Large files are split by logical boundaries (functions, classes).
 * Small files are embedded as a single chunk.
 *
 * @param content - File content
 * @param maxChunkChars - Max chars per chunk (default 8000 ~2000 tokens)
 */
export function chunkFileContent(
  content: string,
  maxChunkChars: number = 8000
): string[] {
  if (content.length <= maxChunkChars) {
    return [content];
  }

  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > maxChunkChars && current.length > 0) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}
