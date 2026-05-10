/**
 * tests/embedding-lifecycle.test.ts
 *
 * Tests for embedding lifecycle hardening:
 *   - File deletion sync
 *   - File rename sync
 *   - Stale embedding cleanup
 *   - Workspace isolation
 *   - Embedding freshness validation
 */

import assert from 'node:assert/strict';
import { FileHashStore, hashContent } from '../lib/memory/incremental-embedding';
import { shouldIgnore, isEligibleExtension } from '../lib/memory/file-ingestion';
import type { IncrementalDiff } from '../lib/memory/incremental-embedding';

// ─── FileHashStore — incremental diff ────────────────────────────────────────

describe('FileHashStore — incremental diff', () => {
  function makeStore(): FileHashStore {
    const store = new FileHashStore();
    // Manually seed with private hashes map via recordEmbedding
    return store;
  }

  test('new file detected as changed', () => {
    const store = makeStore();
    const diff = store.computeDiff([
      { relativePath: 'src/auth.ts', absolutePath: '/ws/src/auth.ts', content: 'export const x = 1;', size: 20, mtime: Date.now(), extension: '.ts' },
    ]);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.unchanged.length, 0);
    assert.equal(diff.deleted.length, 0);
  });

  test('unchanged file detected as unchanged after recording', () => {
    const store = makeStore();
    const file = {
      relativePath: 'src/auth.ts',
      absolutePath: '/ws/src/auth.ts',
      content: 'export const x = 1;',
      size: 20,
      mtime: Date.now(),
      extension: '.ts',
    };
    store.recordEmbedding(file);

    const diff = store.computeDiff([file]);
    assert.equal(diff.changed.length, 0);
    assert.equal(diff.unchanged.length, 1);
  });

  test('modified file detected as changed', () => {
    const store = makeStore();
    const original = {
      relativePath: 'src/auth.ts',
      absolutePath: '/ws/src/auth.ts',
      content: 'const x = 1;',
      size: 12,
      mtime: Date.now(),
      extension: '.ts',
    };
    store.recordEmbedding(original);

    const modified = { ...original, content: 'const x = 2;' };
    const diff = store.computeDiff([modified]);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0].relativePath, 'src/auth.ts');
  });

  test('renamed file detected — same hash different path', () => {
    const store = makeStore();
    const original = {
      relativePath: 'src/auth.ts',
      absolutePath: '/ws/src/auth.ts',
      content: 'const x = 1;',
      size: 12,
      mtime: Date.now(),
      extension: '.ts',
    };
    store.recordEmbedding(original);

    // Simulate rename: same content, new path
    const renamed = { ...original, relativePath: 'lib/auth.ts', absolutePath: '/ws/lib/auth.ts' };
    const diff = store.computeDiff([renamed]);
    assert.equal(diff.renamed.length, 1);
    assert.equal(diff.renamed[0].oldPath, 'src/auth.ts');
    assert.equal(diff.renamed[0].newPath, 'lib/auth.ts');
    assert.equal(diff.changed.length, 0, 'rename should NOT appear in changed');
  });

  test('deleted file detected', () => {
    const store = makeStore();
    const file = {
      relativePath: 'src/deleted.ts',
      absolutePath: '/ws/src/deleted.ts',
      content: 'const x = 1;',
      size: 12,
      mtime: Date.now(),
      extension: '.ts',
    };
    store.recordEmbedding(file);

    // Don't pass the file in new scan — it's deleted
    const diff = store.computeDiff([]);
    assert.equal(diff.deleted.length, 1);
    assert.equal(diff.deleted[0], 'src/deleted.ts');
  });

  test('applyRename updates path in store', () => {
    const store = makeStore();
    const file = {
      relativePath: 'src/auth.ts',
      absolutePath: '/ws/src/auth.ts',
      content: 'const x = 1;',
      size: 12,
      mtime: Date.now(),
      extension: '.ts',
    };
    store.recordEmbedding(file);
    store.applyRename('src/auth.ts', 'lib/auth.ts');

    // After rename: old path should be gone, new path should exist
    const diff = store.computeDiff([
      { ...file, relativePath: 'lib/auth.ts', absolutePath: '/ws/lib/auth.ts' },
    ]);
    assert.equal(diff.changed.length, 0, 'renamed file should not be re-embedded');
    assert.equal(diff.unchanged.length, 1);
  });
});

// ─── File ingestion filters ───────────────────────────────────────────────────

describe('file-ingestion — ignore and extension filters', () => {
  test('node_modules is ignored', () => {
    assert.equal(shouldIgnore('node_modules/react/index.js'), true);
  });

  test('.coatcard is ignored', () => {
    assert.equal(shouldIgnore('.coatcard/vectors.json'), true);
  });

  test('.next is ignored', () => {
    assert.equal(shouldIgnore('.next/server/pages/api.js'), true);
  });

  test('dist is ignored', () => {
    assert.equal(shouldIgnore('dist/bundle.js'), true);
  });

  test('src files are not ignored', () => {
    assert.equal(shouldIgnore('src/auth.ts'), false);
  });

  test('.ts extension is eligible', () => {
    assert.equal(isEligibleExtension('auth.ts'), true);
  });

  test('.tsx extension is eligible', () => {
    assert.equal(isEligibleExtension('page.tsx'), true);
  });

  test('.prisma extension is eligible', () => {
    assert.equal(isEligibleExtension('schema.prisma'), true);
  });

  test('.png is not eligible', () => {
    assert.equal(isEligibleExtension('logo.png'), false);
  });

  test('.lock is not eligible', () => {
    assert.equal(isEligibleExtension('pnpm-lock.yaml'), false);
  });
});

// ─── Content hashing ─────────────────────────────────────────────────────────

describe('hashContent', () => {
  test('same content produces same hash', () => {
    const h1 = hashContent('const x = 1;');
    const h2 = hashContent('const x = 1;');
    assert.equal(h1, h2);
  });

  test('different content produces different hash', () => {
    const h1 = hashContent('const x = 1;');
    const h2 = hashContent('const x = 2;');
    assert.notEqual(h1, h2);
  });

  test('hash is 64 hex chars (sha256)', () => {
    const h = hashContent('test');
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });
});

// ─── Workspace isolation ──────────────────────────────────────────────────────

describe('workspace isolation via WORKSPACE_ROOT', () => {
  test('getWorkspaceId returns different IDs for different workspace roots', () => {
    const { getWorkspaceId } = require('../lib/memory/project-memory-path');

    const original = process.env.WORKSPACE_ROOT;
    try {
      process.env.WORKSPACE_ROOT = '/projects/app-a';
      const idA = getWorkspaceId();

      process.env.WORKSPACE_ROOT = '/projects/app-b';
      const idB = getWorkspaceId();

      assert.notEqual(idA, idB, 'Different workspace roots must produce different IDs');
    } finally {
      if (original !== undefined) {
        process.env.WORKSPACE_ROOT = original;
      } else {
        delete process.env.WORKSPACE_ROOT;
      }
    }
  });

  test('WORKSPACE_ID env var overrides derived workspace ID', () => {
    const { getWorkspaceId } = require('../lib/memory/project-memory-path');

    const originalId = process.env.WORKSPACE_ID;
    try {
      process.env.WORKSPACE_ID = 'custom-workspace-id';
      assert.equal(getWorkspaceId(), 'custom-workspace-id');
    } finally {
      if (originalId !== undefined) {
        process.env.WORKSPACE_ID = originalId;
      } else {
        delete process.env.WORKSPACE_ID;
      }
    }
  });
});
