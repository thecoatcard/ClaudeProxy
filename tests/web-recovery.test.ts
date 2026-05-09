// tests/web-recovery.test.ts
// Tests for the web recovery error classification engine.

import assert from 'node:assert/strict';
import {
  classifyAndRecover,
  requiresWebSearch,
} from '../lib/agent/web-recovery.js';

describe('classifyAndRecover', () => {
  test('classifies Prisma migration errors', () => {
    const result = classifyAndRecover('Error: prisma migrate failed: Cannot find Prisma Schema');
    assert.equal(result.errorClass, 'prisma_migration');
    assert.ok(result.searchQueries.length > 0);
    assert.ok(result.priorityDomains.includes('prisma.io'));
  });

  test('classifies Next.js config errors', () => {
    const result = classifyAndRecover('Invalid next.config.ts: Unrecognized key "experimental.serverComponentsExternalPackages"');
    assert.equal(result.errorClass, 'nextjs_config');
    assert.ok(result.priorityDomains.includes('nextjs.org'));
  });

  test('classifies shadcn init errors', () => {
    const result = classifyAndRecover('Cannot find package shadcn-ui init failed');
    assert.equal(result.errorClass, 'shadcn_init');
    assert.ok(result.priorityDomains.includes('ui.shadcn.com'));
  });

  test('classifies Tailwind config errors', () => {
    const result = classifyAndRecover('tailwind config error: Cannot find tailwind.config.js');
    assert.equal(result.errorClass, 'tailwind_config');
    assert.ok(result.guidance.includes('v4'));
  });

  test('classifies package export errors', () => {
    const result = classifyAndRecover('does not provide an export named "createServer"');
    assert.equal(result.errorClass, 'package_export_missing');
    assert.ok(result.searchQueries.length > 0);
  });

  test('classifies CLI argument errors', () => {
    const result = classifyAndRecover('error: unrecognized option --watch passed to vite build');
    assert.equal(result.errorClass, 'cli_argument_mismatch');
    assert.ok(result.guidance.includes('web_search'));
  });

  test('unknown error returns unknown class', () => {
    const result = classifyAndRecover('something completely random abc 123');
    assert.equal(result.errorClass, 'unknown');
  });

  test('shouldSearch is true for known classes at repeat=1', () => {
    const result = classifyAndRecover('PrismaClientInitializationError: connection failed', {}, 1);
    assert.equal(result.shouldSearch, true);
  });

  test('shouldSearch is true for unknown class at repeat>=2', () => {
    const result = classifyAndRecover('random error', {}, 2);
    assert.equal(result.shouldSearch, true);
  });

  test('shouldSearch is false for unknown class at repeat=1', () => {
    const result = classifyAndRecover('random error', {}, 1);
    assert.equal(result.shouldSearch, false);
  });

  test('guidance includes search queries', () => {
    const result = classifyAndRecover('prisma migrate error P1000', {}, 1);
    assert.ok(result.guidance.includes('"'));
    assert.ok(result.guidance.includes('prisma') || result.guidance.toLowerCase().includes('recovery'));
  });
});

describe('requiresWebSearch', () => {
  test('returns true for Prisma errors', () => {
    assert.equal(requiresWebSearch('prisma migrate deploy failed'), true);
  });

  test('returns true for shadcn init errors', () => {
    assert.equal(requiresWebSearch('shadcn init failed not found'), true);
  });

  test('returns true for next-auth errors', () => {
    assert.equal(requiresWebSearch('next-auth session error'), true);
  });

  test('returns false for generic errors', () => {
    assert.equal(requiresWebSearch('syntax error at line 5'), false);
  });
});
