/**
 * tests/incremental-embedding.test.ts
 * Tests for lib/memory/incremental-embedding.ts
 */

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

import { FileHashStore, hashContent } from '../lib/memory/incremental-embedding';
import type { FileEntry } from '../lib/memory/file-ingestion';

function makeFile(relativePath: string, content: string): FileEntry {
  return {
    absolutePath: `/project/${relativePath}`,
    relativePath,
    content,
    size: content.length,
    extension: '.ts',
  };
}

describe('incremental-embedding', () => {
  describe('hashContent', () => {
    it('should return consistent SHA-256 hex', () => {
      const hash1 = hashContent('hello');
      const hash2 = hashContent('hello');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it('should differ for different content', () => {
      expect(hashContent('a')).not.toBe(hashContent('b'));
    });
  });

  describe('FileHashStore', () => {
    let store: FileHashStore;

    beforeEach(() => {
      store = new FileHashStore('/project');
      jest.clearAllMocks();
    });

    it('should start with size 0', () => {
      expect(store.size).toBe(0);
    });

    it('should detect all files as changed on first run', () => {
      const files = [
        makeFile('src/a.ts', 'const a = 1;'),
        makeFile('src/b.ts', 'const b = 2;'),
      ];

      const diff = store.computeDiff(files);
      expect(diff.changed).toHaveLength(2);
      expect(diff.unchanged).toHaveLength(0);
      expect(diff.deleted).toHaveLength(0);
    });

    it('should detect unchanged files after recording', () => {
      const file = makeFile('src/a.ts', 'const a = 1;');
      store.recordEmbedding(file);

      const diff = store.computeDiff([file]);
      expect(diff.changed).toHaveLength(0);
      expect(diff.unchanged).toHaveLength(1);
    });

    it('should detect changed files', () => {
      const file1 = makeFile('src/a.ts', 'const a = 1;');
      store.recordEmbedding(file1);

      const file2 = makeFile('src/a.ts', 'const a = 2;'); // content changed
      const diff = store.computeDiff([file2]);
      expect(diff.changed).toHaveLength(1);
      expect(diff.unchanged).toHaveLength(0);
    });

    it('should detect deleted files', () => {
      const file = makeFile('src/a.ts', 'const a = 1;');
      store.recordEmbedding(file);

      const diff = store.computeDiff([]); // no files on disk
      expect(diff.deleted).toEqual(['src/a.ts']);
    });

    it('should remove records', () => {
      const file = makeFile('src/a.ts', 'const a = 1;');
      store.recordEmbedding(file);
      expect(store.size).toBe(1);
      store.removeRecord('src/a.ts');
      expect(store.size).toBe(0);
    });

    it('should load from disk', () => {
      const fs = require('fs');
      const records = [
        { path: 'src/a.ts', hash: hashContent('x'), embeddedAt: 1000, size: 1 },
      ];
      fs.existsSync.mockReturnValueOnce(true);
      fs.readFileSync.mockReturnValueOnce(JSON.stringify(records));

      const s = new FileHashStore('/project');
      s.load();
      expect(s.size).toBe(1);
    });

    it('should save to disk', () => {
      const fs = require('fs');
      fs.existsSync.mockReturnValue(true);

      store.recordEmbedding(makeFile('src/a.ts', 'x'));
      store.save();
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    });
  });
});
