describe('runtime config guards', () => {
  beforeEach(() => {
    delete process.env.MONGODB_URI;
    delete process.env.MONGODB_DB;
  });

  it('requires Mongo connection settings', async () => {
    const { getMongoConfig } = await import('@/lib/mongodb');
    expect(() => getMongoConfig()).toThrow('MONGODB_URI is not configured');
  });
});
