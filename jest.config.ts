import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // Resolve TypeScript source for .js extension imports (e.g. ../lib/redis/client.js)
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Replace nanoid (ESM-only v5+) with a CJS-compatible mock for Jest
    '^nanoid$': '<rootDir>/__mocks__/nanoid.js',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { module: 'commonjs', esModuleInterop: true } }],
  },
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
};

export default config;
