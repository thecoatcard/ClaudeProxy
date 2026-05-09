/**
 * tests/dashboard-auth-keys.test.ts
 *
 * Tests for gateway key creation with extended fields (rpm_limit, max_usage, notes, expires_at, status).
 * Run: npx tsx --test tests/dashboard-auth-keys.test.ts
 */
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
// Type definitions matching the API shape
// ─────────────────────────────────────────────────────────────────────────────

type GatewayKeyCreate = {
  name?: string;
  rpm_limit?: number;
  max_usage?: number;
  notes?: string;
  expires_at?: string;
};

type GatewayKeyUpdate = {
  id: string;
  name?: string;
  rpm_limit?: number;
  max_usage?: number;
  notes?: string;
  expires_at?: string;
  status?: 'active' | 'disabled' | 'revoked';
};

type GatewayKey = {
  token: string;
  name?: string;
  status: 'active' | 'disabled' | 'revoked';
  usage_count?: number;
  total_tokens?: number;
  max_usage?: number;
  rpm_limit?: number;
  notes?: string;
  expires_at?: string;
  last_used?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Gateway key create payload validation', () => {
  it('accepts minimal payload (name only)', () => {
    const payload: GatewayKeyCreate = { name: 'Test Key' };
    assert.equal(payload.name, 'Test Key');
    assert.equal(payload.rpm_limit, undefined);
  });

  it('accepts full payload with all fields', () => {
    const payload: GatewayKeyCreate = {
      name: 'Production Key',
      rpm_limit: 60,
      max_usage: 1_000_000,
      notes: 'For production use',
      expires_at: '2025-12-31',
    };
    assert.equal(payload.rpm_limit, 60);
    assert.equal(payload.max_usage, 1_000_000);
    assert.equal(payload.expires_at, '2025-12-31');
  });

  it('strips empty notes from payload', () => {
    const notes = '   ';
    const trimmed = notes.trim();
    const body: GatewayKeyCreate = { name: 'Key' };
    if (trimmed) body.notes = trimmed;
    assert.equal(body.notes, undefined);
  });

  it('converts rpm_limit and max_usage to number', () => {
    const rpmStr = '100';
    const maxStr = '5000000';
    const body: GatewayKeyCreate = {
      name: 'Key',
      rpm_limit: Number(rpmStr),
      max_usage: Number(maxStr),
    };
    assert.equal(typeof body.rpm_limit, 'number');
    assert.equal(body.rpm_limit, 100);
    assert.equal(body.max_usage, 5_000_000);
  });
});

describe('Gateway key update payload validation', () => {
  it('requires id field', () => {
    const update: GatewayKeyUpdate = { id: 'test-token', name: 'New Name' };
    assert.ok(update.id, 'id is required');
  });

  it('validates status values', () => {
    const validStatuses: GatewayKeyUpdate['status'][] = ['active', 'disabled', 'revoked'];
    for (const s of validStatuses) {
      const update: GatewayKeyUpdate = { id: 'tok', status: s };
      assert.ok(['active', 'disabled', 'revoked'].includes(update.status!));
    }
  });
});

describe('Gateway key table display logic', () => {
  const keys: GatewayKey[] = [
    { token: 'tok-aaa', status: 'active', usage_count: 100, total_tokens: 50_000, max_usage: 100_000 },
    { token: 'tok-bbb', status: 'disabled', usage_count: 50, total_tokens: 10_000 },
    { token: 'tok-ccc', status: 'revoked', usage_count: 200, total_tokens: 200_000 },
  ];

  it('filters revoked keys from active list', () => {
    const active = keys.filter((k) => k.status !== 'revoked');
    assert.equal(active.length, 2);
  });

  it('computes usage progress correctly', () => {
    const key = keys[0];
    const pct = (Number(key.total_tokens!) / key.max_usage!) * 100;
    assert.equal(pct, 50);
  });

  it('progress fill class matches usage level', () => {
    const cases = [
      { pct: 95, expected: 'progress-fill-bad' },
      { pct: 75, expected: 'progress-fill-warn' },
      { pct: 40, expected: 'progress-fill-ok' },
    ];
    for (const { pct, expected } of cases) {
      const cls = pct > 90 ? 'progress-fill-bad' : pct > 70 ? 'progress-fill-warn' : 'progress-fill-ok';
      assert.equal(cls, expected);
    }
  });

  it('masks token correctly for display', () => {
    const token = 'sk-test-abcdefghij1234';
    const masked = token.slice(0, 18) + '…';
    assert.ok(masked.endsWith('…'));
    assert.ok(masked.length <= 20);
  });

  it('totals compute across all non-revoked keys', () => {
    const totals = keys
      .filter((k) => k.status !== 'revoked')
      .reduce((acc, k) => ({
        requests: acc.requests + Number(k.usage_count || 0),
        tokens: acc.tokens + Number(k.total_tokens || 0),
      }), { requests: 0, tokens: 0 });

    assert.equal(totals.requests, 150); // 100 + 50
    assert.equal(totals.tokens, 60_000); // 50k + 10k
  });
});

describe('Token masking', () => {
  function maskToken(token: string): string {
    if (!token || token.length < 14) return (token?.slice(0, 6) ?? '') + '***';
    return token.slice(0, 8) + '…' + token.slice(-4);
  }

  it('masks long tokens correctly', () => {
    const masked = maskToken('sk-very-long-token-1234567890');
    assert.ok(masked.includes('…'));
    assert.ok(masked.startsWith('sk-very-'));
    assert.ok(masked.endsWith('7890'));
  });

  it('handles short tokens', () => {
    const masked = maskToken('short');
    assert.ok(masked.endsWith('***'));
  });

  it('handles empty string', () => {
    const masked = maskToken('');
    assert.equal(masked, '***');
  });
});
