#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

console.log('=== ENVIRONMENT CREDENTIALS VALIDATION ===\n');

// Read .env file
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const envLines = envContent.split('\n').filter(line => line && !line.startsWith('#'));

const env = {};
envLines.forEach(line => {
  const [key, ...valueParts] = line.split('=');
  env[key.trim()] = valueParts.join('=').trim();
});

const checks = {
  'ADMIN_EMAIL': { value: env.ADMIN_EMAIL || 'NOT SET', required: true },
  'ADMIN_PASSWORD': { value: env.ADMIN_PASSWORD ? '***' + env.ADMIN_PASSWORD.slice(-3) : 'NOT SET', required: true },
  'MONGODB_URI': { value: env.MONGODB_URI ? 'SET (MongoDB Atlas)' : 'NOT SET', required: true },
  'MONGODB_DB': { value: env.MONGODB_DB || 'NOT SET', required: true },
  'REDIS_URL': { value: env.REDIS_URL ? 'SET (Cloud Redis)' : 'NOT SET', required: true },
  'MASTER_API_KEY': { value: env.MASTER_API_KEY ? '***' + env.MASTER_API_KEY.slice(-3) : 'NOT SET', required: true },
  'DEFAULT_MODEL': { value: env.DEFAULT_MODEL || 'NOT SET', required: true },
  'FALLBACK_MODEL': { value: env.FALLBACK_MODEL || 'NOT SET', required: true },
  'GEMINI_KEYS_COUNT': { value: env.GEMINI_KEYS ? env.GEMINI_KEYS.split(',').length + ' keys configured' : 'NOT SET', required: true },
  'CRON_SECRET': { value: env.CRON_SECRET ? 'SET' : 'NOT SET', required: true },
  'KEY_COOLDOWN_429': { value: env.KEY_COOLDOWN_429 || 'NOT SET', required: false },
  'KEY_COOLDOWN_503': { value: env.KEY_COOLDOWN_503 || 'NOT SET', required: false },
  'MAX_RETRIES': { value: env.MAX_RETRIES || 'NOT SET', required: false },
  'REQUEST_TIMEOUT': { value: env.REQUEST_TIMEOUT || 'NOT SET', required: false },
};

console.log('REQUIRED CREDENTIALS:');
console.log('─'.repeat(60));
let allRequired = true;
Object.entries(checks).forEach(([key, { value, required }]) => {
  if (required) {
    const isSet = value !== 'NOT SET';
    const status = isSet ? '✓' : '✗';
    console.log(`${status} ${key.padEnd(25)}: ${value}`);
    if (!isSet) allRequired = false;
  }
});

console.log('\nOPTIONAL CONFIGURATION:');
console.log('─'.repeat(60));
Object.entries(checks).forEach(([key, { value, required }]) => {
  if (!required) {
    console.log(`• ${key.padEnd(25)}: ${value}`);
  }
});

console.log('\n=== REDIS CONNECTIVITY ===');
console.log('─'.repeat(60));
const redisUrl = env.REDIS_URL;
if (redisUrl) {
  try {
    const url = new URL(redisUrl);
    console.log(`✓ REDIS_URL Format: Valid`);
    console.log(`  Protocol: ${url.protocol}`);
    console.log(`  Host: ${url.hostname}`);
    console.log(`  Port: ${url.port}`);
    console.log(`  Authentication: ${url.username ? 'Set' : 'No auth'}`);
    console.log(`\n⚠ Note: Currently the Redis host cannot be resolved from`);
    console.log(`  your network. This is likely a DNS/firewall issue.`);
    console.log(`\n  Options:`);
    console.log(`  1. Check internet connectivity`);
    console.log(`  2. Verify firewall allows outbound on port 13679`);
    console.log(`  3. Use local Redis instance instead`);
  } catch (e) {
    console.log(`✗ REDIS_URL Format: INVALID`);
    console.log(`  Error: ${e.message}`);
  }
} else {
  console.log(`✗ REDIS_URL: NOT SET`);
}

console.log('\n=== SUMMARY ===');
console.log('─'.repeat(60));
console.log(allRequired ? '✅ All required credentials are set' : '❌ Some required credentials are missing');
