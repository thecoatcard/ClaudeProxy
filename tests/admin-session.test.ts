import { createAdminSession, verifyAdminSession } from '@/lib/admin-session';

describe('signed admin sessions', () => {
  beforeEach(() => {
    process.env.MASTER_API_KEY = 'test-master-key';
  });

  it('round-trips a valid session without Redis', () => {
    const token = createAdminSession('admin@example.com');
    expect(verifyAdminSession(token)?.email).toBe('admin@example.com');
  });

  it('rejects a tampered session', () => {
    const token = createAdminSession('admin@example.com');
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(verifyAdminSession(tampered)).toBeNull();
  });
});
