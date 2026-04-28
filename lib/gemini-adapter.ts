export async function callGemini(internalModel: string, apiKey: string, body: any, stream: boolean) {
  const mode = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${internalModel}:${mode}&key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return res;
}
