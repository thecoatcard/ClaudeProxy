import fs from 'fs';
import Redis from 'ioredis';

const env = fs.readFileSync('.env', 'utf8').split('\n');
let redisUrl = '';
for (const line of env) {
  if (line.startsWith('REDIS_URL=')) redisUrl = line.split('=')[1].trim().replace(/['"]/g, '');
}

if (!redisUrl) {
  console.error("REDIS_URL not found in .env");
  process.exit(1);
}

const client = new Redis(redisUrl);

async function activateAllKeys() {
  const keys = await client.zrange('gemini:key_pool', 0, -1);

  if (!keys || keys.length === 0) {
    console.log("No keys found.");
    await client.quit();
    return;
  }

  console.log(`Found ${keys.length} keys. Activating...`);

  let count = 0;
  for (const id of keys) {
    // get key data
    const props = await client.hgetall(`gemini:key:${id}`);
    
    let rpmUsed = Number(props.rpm_used || 0);

    // Set status healthy, failure_count 0, cooldown_until 0
    await client.hset(`gemini:key:${id}`, {
      status: 'healthy',
      failure_count: 0,
      cooldown_until: 0
    });

    // Reset score to 100 - rpmUsed
    await client.zadd('gemini:key_pool', 100 - rpmUsed, id);
    
    count++;
  }

  console.log(`Successfully activated ${count} keys!`);
  await client.quit();
}

activateAllKeys().catch(async (err) => {
  console.error(err);
  await client.quit();
});
