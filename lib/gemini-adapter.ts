export async function callGemini(
  internalModel: string, 
  apiKey: string, 
  body: any, 
  stream: boolean,
  signal?: AbortSignal
) {
  const path = stream ? 'streamGenerateContent' : 'generateContent';
  const query = stream ? `alt=sse&key=${apiKey}` : `key=${apiKey}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${internalModel}:${path}?${query}`;

  const timeout = Number(process.env.REQUEST_TIMEOUT || 60000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: signal || controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}
