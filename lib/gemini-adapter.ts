export interface GeminiCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function callGemini(
  internalModel: string,
  apiKey: string,
  body: any,
  stream: boolean,
  options: GeminiCallOptions = {},
) {
  const path = stream ? 'streamGenerateContent' : 'generateContent';
  const query = stream ? `alt=sse&key=${apiKey}` : `key=${apiKey}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${internalModel}:${path}?${query}`;

  // NOTE: do not set Accept-Encoding manually. Runtime handles decompression.
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 60_000);
  const timeoutId = setTimeout(() => {
    try { controller.abort(`callGemini timeout after ${timeoutMs}ms`); } catch { /* noop */ }
  }, timeoutMs);
  timeoutId.unref?.();

  const externalSignal = options.signal;
  const abortFromExternal = () => {
    try { controller.abort(externalSignal?.reason ?? 'aborted'); } catch { /* noop */ }
  };

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', abortFromExternal, { once: true });
  }

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
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternal);
    }
  }
}
