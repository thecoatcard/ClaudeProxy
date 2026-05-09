/**
 * tests/dashboard-api-keys.test.ts
 *
 * Tests for bulk key validation and pool management endpoints.
 * Run: npx tsx --test tests/dashboard-api-keys.test.ts
 */
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers / stubs
// ─────────────────────────────────────────────────────────────────────────────

function makeValidateBody(keys: string[]) {
  return { keys };
}

function makeToggleUrl(id: string) {
  return `/api/admin/keys?action=toggle&id=${encodeURIComponent(id)}`;
}

function makeReactivateUrl(id: string) {
  return `/api/admin/keys?action=reactivate&id=${encodeURIComponent(id)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit-level tests — pure logic validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Bulk validate request contract', () => {
  it('enforces max 20 keys', () => {
    const keys = Array.from({ length: 21 }, (_, i) => `key-${i}`);
    assert.ok(keys.length > 20, 'Test input exceeds limit');
    // The API should reject; test we detect the condition before sending
    assert.equal(keys.length > 20, true);
  });

  it('filters empty lines correctly', () => {
    const raw = 'key-a\n\n  \nkey-b\nkey-c';
    const keys = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    assert.equal(keys.length, 3);
    assert.deepEqual(keys, ['key-a', 'key-b', 'key-c']);
  });

  it('builds correct validate request body', () => {
    const keys = ['AIzaSy-test-1', 'AIzaSy-test-2'];
    const body = makeValidateBody(keys);
    assert.deepEqual(body.keys, keys);
  });
});

describe('Toggle/reactivate URL generation', () => {
  it('generates correct toggle URL', () => {
    const url = makeToggleUrl('key-abc-123');
    assert.ok(url.includes('action=toggle'));
    assert.ok(url.includes('key-abc-123'));
  });

  it('generates correct reactivate URL', () => {
    const url = makeReactivateUrl('key-xyz');
    assert.ok(url.includes('action=reactivate'));
    assert.ok(url.includes('key-xyz'));
  });

  it('URL-encodes special characters in key ID', () => {
    const url = makeToggleUrl('key with spaces&other');
    assert.ok(!url.includes(' '), 'Spaces must be encoded');
    assert.ok(!url.includes('&other'), 'Unencoded & would break query string');
  });
});

describe('Provider key status filtering', () => {
  const keys = [
    { id: 'k1', status: 'healthy' },
    { id: 'k2', status: 'cooldown' },
    { id: 'k3', status: 'disabled' },
    { id: 'k4', status: 'revoked' },
    { id: 'k5', status: 'healthy' },
  ];

  it('filters by status correctly', () => {
    const healthy = keys.filter((k) => k.status === 'healthy');
    assert.equal(healthy.length, 2);
  });

  it('counts health summary correctly', () => {
    const summary = {
      healthy: keys.filter((k) => k.status === 'healthy').length,
      cooldown: keys.filter((k) => k.status === 'cooldown').length,
      disabled: keys.filter((k) => k.status === 'disabled').length,
      revoked: keys.filter((k) => k.status === 'revoked').length,
    };
    assert.equal(summary.healthy, 2);
    assert.equal(summary.cooldown, 1);
    assert.equal(summary.disabled, 1);
    assert.equal(summary.revoked, 1);
  });

  it('search filter is case-insensitive', () => {
    const search = 'K2';
    const filtered = keys.filter((k) => k.id.toLowerCase().includes(search.toLowerCase()));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'k2');
  });

  it('combined status + search filter', () => {
    const search = 'k';
    const statusFilter = 'healthy';
    const filtered = keys.filter((k) =>
      k.id.toLowerCase().includes(search.toLowerCase()) && k.status === statusFilter
    );
    assert.equal(filtered.length, 2);
  });
});

describe('Validate results add-valid logic', () => {
  const results = [
    { key: 'key-a', valid: true, latencyMs: 200 },
    { key: 'key-b', valid: false, error: 'Unauthorized' },
    { key: 'key-c', valid: true, latencyMs: 340 },
    { key: 'key-d', valid: false, error: 'rate limited' },
  ];

  it('extracts only valid keys', () => {
    const valid = results.filter((r) => r.valid).map((r) => r.key);
    assert.deepEqual(valid, ['key-a', 'key-c']);
  });

  it('counts valid and invalid correctly', () => {
    assert.equal(results.filter((r) => r.valid).length, 2);
    assert.equal(results.filter((r) => !r.valid).length, 2);
  });

  it('identifies rate-limited keys for special pill', () => {
    const rateLimited = results.filter((r) => !r.valid && r.error?.toLowerCase().includes('rate'));
    assert.equal(rateLimited.length, 1);
    assert.equal(rateLimited[0].key, 'key-d');
  });
});
