import fs from 'fs';
import https from 'https';

const env = fs.readFileSync('.env', 'utf8').split('\n');
let redisUrl = '', redisToken = '';
for (const line of env) {
  if (line.startsWith('REDIS_URL=')) redisUrl = line.split('=')[1].trim().replace(/['"]/g, '');
  if (line.startsWith('REDIS_TOKEN=')) redisToken = line.split('=')[1].trim().replace(/['"]/g, '');
}
async function activateAllKeys() {
  const res = await fetch(`${redisUrl}/zrange/gemini:key_pool/0/-1`, {
    headers: { Authorization: `Bearer ${redisToken}` }
  });
  const data = await res.json();
  const keys = data.result;

  if (!keys || keys.length === 0) {
    console.log("No keys found.");
    return;
  }

  console.log(`Found ${keys.length} keys. Activating...`);

  let count = 0;
  for (const id of keys) {
    // get key data
    const kRes = await fetch(`${redisUrl}/hgetall/gemini:key:${id}`, {
      headers: { Authorization: `Bearer ${redisToken}` }
    });
    const kData = await kRes.json();
    const props = kData.result;
    
    // Convert array format [k1, v1, k2, v2] to object if needed
    let rpmUsed = 0;
    if (Array.isArray(props)) {
      for (let i = 0; i < props.length; i += 2) {
        if (props[i] === 'rpm_used') rpmUsed = Number(props[i+1]);
      }
    } else if (props && props.rpm_used) {
      rpmUsed = Number(props.rpm_used);
    }

    // Set status healthy, failure_count 0, cooldown_until 0
    await fetch(`${redisUrl}/hset/gemini:key:${id}/status/healthy/failure_count/0/cooldown_until/0`, {
      headers: { Authorization: `Bearer ${redisToken}` }
    });

    // Reset score to 100 - rpmUsed
    await fetch(`${redisUrl}/zadd/gemini:key_pool/${100 - rpmUsed}/${id}`, {
      headers: { Authorization: `Bearer ${redisToken}` }
    });
    
    count++;
  }

  console.log(`Successfully activated ${count} keys!`);
}

activateAllKeys().catch(console.error);
