import { getMongoDb } from '@/lib/mongodb';
import { MongoRunRepository } from './mongo-repository';

let repositoryPromise: Promise<MongoRunRepository> | null = null;

export function getRunRepository() {
  if (!repositoryPromise) {
    repositoryPromise = getMongoDb()
      .then(async (db) => {
        const repository = new MongoRunRepository(db);
        await repository.ensureIndexes();
        return repository;
      })
      .catch((error) => {
        repositoryPromise = null;
        throw error;
      });
  }

  return repositoryPromise;
}
