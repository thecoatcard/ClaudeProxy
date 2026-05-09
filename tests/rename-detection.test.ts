/**
 * tests/rename-detection.test.ts
 *
 * Tests for rename detection in incremental embedding.
 */

jest.mock('@/lib/memory/project-memory-path', () => ({
  getFileHashesPath: () => '/tmp/test-hashes.json',
  isLocalCacheEnabled: () => false,
}));

import { FileHashStore, hashContent } from '@/lib/memory/incremental-embedding';
import type { FileEntry } from '@/lib/memory/file-ingestion';

function makeFile(relativePath: string, content: string): FileEntry {
  return {
    relativePath,
    absolutePath: `/project/${relativePath}`,
    content,
    size: content.length,
    mtime: Date.now(),
    extension: '.ts',
  };
}

describe('FileHashStore rename detection', () => {
  let store: FileHashStore;

  beforeEach(() => {
    store = new FileHashStore();
  });

  test('detects unchanged files', () => {
    const file = makeFile('lib/auth.ts', 'export function auth() {}');
    store.recordEmbedding(file);

    const diff = store.computeDiff([file]);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.deleted).toHaveLength(0);
    expect(diff.renamed).toHaveLength(0);
  });

  test('detects changed files', () => {
    const original = makeFile('lib/auth.ts', 'export function auth() {}');
    store.recordEmbedding(original);

    const modified = makeFile('lib/auth.ts', 'export function auth() { return true; }');
    const diff = store.computeDiff([modified]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.unchanged).toHaveLength(0);
  });

  test('detects new files', () => {
    const file = makeFile('lib/new.ts', 'new content');
    const diff = store.computeDiff([file]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.unchanged).toHaveLength(0);
  });

  test('detects deleted files', () => {
    const file = makeFile('lib/old.ts', 'old content');
    store.recordEmbedding(file);

    const diff = store.computeDiff([]);
    expect(diff.deleted).toHaveLength(1);
    expect(diff.deleted[0]).toBe('lib/old.ts');
  });

  test('detects renamed files (same hash, different path)', () => {
    const content = 'export function helper() { return 42; }';
    const original = makeFile('lib/old-name.ts', content);
    store.recordEmbedding(original);

    // File now at new path with same content
    const renamed = makeFile('lib/new-name.ts', content);
    const diff = store.computeDiff([renamed]);

    expect(diff.renamed).toHaveLength(1);
    expect(diff.renamed[0].oldPath).toBe('lib/old-name.ts');
    expect(diff.renamed[0].newPath).toBe('lib/new-name.ts');
    expect(diff.renamed[0].hash).toBe(hashContent(content));
    // Renamed file should be in unchanged (no re-embedding needed)
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.changed).toHaveLength(0);
    // Old path should NOT appear in deleted (it was renamed, not deleted)
    expect(diff.deleted).toHaveLength(0);
  });

  test('treats copy (both old and new path exist) as changed, not renamed', () => {
    const content = 'shared content';
    const original = makeFile('lib/original.ts', content);
    store.recordEmbedding(original);

    // Both paths exist — it's a copy
    const copy = makeFile('lib/copy.ts', content);
    const diff = store.computeDiff([original, copy]);

    expect(diff.renamed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1); // original
    expect(diff.changed).toHaveLength(1);   // copy (new file)
  });

  test('applyRename updates the hash record path', () => {
    const file = makeFile('lib/old.ts', 'content');
    store.recordEmbedding(file);
    expect(store.size).toBe(1);

    store.applyRename('lib/old.ts', 'lib/new.ts');
    expect(store.size).toBe(1);

    // Now scan with new path — should be unchanged
    const newFile = makeFile('lib/new.ts', 'content');
    const diff = store.computeDiff([newFile]);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.changed).toHaveLength(0);
  });

  test('multiple renames are detected correctly', () => {
    const content1 = 'content one';
    const content2 = 'content two';
    store.recordEmbedding(makeFile('a.ts', content1));
    store.recordEmbedding(makeFile('b.ts', content2));

    const diff = store.computeDiff([
      makeFile('x.ts', content1),
      makeFile('y.ts', content2),
    ]);

    expect(diff.renamed).toHaveLength(2);
    expect(diff.deleted).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });
});
