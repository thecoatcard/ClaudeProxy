import fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n');
let redisUrl = '', redisToken = '';
for (const line of env) {
  if (line.startsWith('REDIS_URL=')) redisUrl = line.split('=')[1].trim().replace(/['"]/g, '');
  if (line.startsWith('REDIS_TOKEN=')) redisToken = line.split('=')[1].trim().replace(/['"]/g, '');
}

async function run() {
  const res = await fetch(`${redisUrl}/zrange/gemini:key_pool/0/-1`, {
    headers: { Authorization: `Bearer ${redisToken}` }
  });
  const data = await res.json();
  const keyId = data.result[0];

  const res2 = await fetch(`${redisUrl}/hget/gemini:key:${keyId}/key`, {
    headers: { Authorization: `Bearer ${redisToken}` }
  });
  const data2 = await res2.json();
  const apiKey = data2.result;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: [
      { role: 'user', parts: [{ text: 'hi' }] }
    ],
    generationConfig: { maxOutputTokens: 64000 }
  };

  const gres = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const gdata = await gres.json();
  console.log(JSON.stringify(gdata, null, 2));
}
run();
