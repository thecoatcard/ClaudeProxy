export async function callGemini(internalModel: string, apiKey: string, body: any, stream: boolean) {
  const path = stream ? 'streamGenerateContent' : 'generateContent';
  const query = stream ? `alt=sse&key=${apiKey}` : `key=${apiKey}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${internalModel}:${path}?${query}`;

  // NOTE: do NOT set Accept-Encoding manually — undici/Edge fetch disables
  // automatic decompression the moment this header is user-controlled, and
  // json()/stream parsing then fails on raw compressed bytes. The runtime
  // already negotiates gzip/br on our behalf.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}
