import { getMongoDb } from '@/lib/mongodb';
import { MongoAgentSessionRepository } from './session-repository';

let sessionRepositoryPromise: Promise<MongoAgentSessionRepository> | null = null;

export function getAgentSessionRepository() {
  if (!sessionRepositoryPromise) {
    sessionRepositoryPromise = getMongoDb()
      .then(async (db) => {
        const repository = new MongoAgentSessionRepository(db);
        await repository.ensureIndexes();
        return repository;
      })
      .catch((error) => {
        sessionRepositoryPromise = null;
        throw error;
      });
  }

  return sessionRepositoryPromise;
}
