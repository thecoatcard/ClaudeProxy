import { Db, MongoClient } from 'mongodb';

let clientPromise: Promise<MongoClient> | null = null;

export class MongoConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'MongoConfigurationError'; }
}

export function getMongoConfig() {
  const uri = process.env.MONGODB_URI?.trim();
  const dbName = process.env.MONGODB_DB?.trim();
  if (!uri) throw new MongoConfigurationError('MONGODB_URI is not configured');
  if (!dbName) throw new MongoConfigurationError('MONGODB_DB is not configured');
  return { uri, dbName };
}

export async function getMongoDb(): Promise<Db> {
  const { uri, dbName } = getMongoConfig();
  if (!clientPromise) {
    clientPromise = new MongoClient(uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 5000 })
      .connect().catch((error) => { clientPromise = null; throw error; });
  }
  return (await clientPromise).db(dbName);
}

export async function closeMongoForTests() {
  const promise = clientPromise;
  clientPromise = null;
  const client = await promise?.catch(() => null);
  await client?.close();
}
