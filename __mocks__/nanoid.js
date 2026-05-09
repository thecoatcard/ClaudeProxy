/**
 * __mocks__/nanoid.js
 *
 * CJS-compatible mock for nanoid (v5 is ESM-only and breaks ts-jest).
 * Used by Jest via moduleNameMapper in jest.config.ts.
 * Produces deterministic-format IDs (URL-safe base64, correct length).
 */
'use strict';

const { randomBytes } = require('node:crypto');

function nanoid(size = 21) {
  // URL-safe base64 characters (matches nanoid's alphabet)
  return randomBytes(size).toString('base64url').slice(0, size);
}

module.exports = { nanoid };
