import { getHealthiestKeyObj, reportKeyFailure, recordKeyUsage } from './key-manager';
import { getModelMapping } from './model-router';
import { callGemini } from './gemini-adapter';

export async function executeWithRetry(
  anthropicModel: string,
  geminiBody: any,
  stream: boolean
) {
  const modelMap = await getModelMapping(anthropicModel);
  const fallbacks = Array.isArray(modelMap.fallback) ? modelMap.fallback : (modelMap.fallback ? [modelMap.fallback] : []);
  const configuredRetries = Number(process.env.MAX_RETRIES || 3);
  const maxRetries = Math.max(configuredRetries, fallbacks.length + 2);
  
  let currentInternalModel = modelMap.primary;
  let fallbackIndex = 0;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const keyObj = await getHealthiestKeyObj();
    
    if (!keyObj) {
      throw new Error('overloaded_error'); // will be mapped to 529
    }

    try {
      const res = await callGemini(currentInternalModel, keyObj.key, geminiBody, stream);

      if (res.status === 429) {
        await reportKeyFailure(keyObj.id, true);
        lastError = { status: 429 };
        continue;
      }

      if (res.status === 503 || res.status >= 500) {
        await reportKeyFailure(keyObj.id, false);
        // switch to next fallback if available
        if (fallbackIndex < fallbacks.length) {
          currentInternalModel = fallbacks[fallbackIndex];
          fallbackIndex++;
        }
        lastError = { status: res.status };
        continue;
      }

      if (!res.ok) {
        const err = await res.json().catch(()=>({}));
        console.error("Gemini API Error:", JSON.stringify(err, null, 2));
        
        // DEBUG: Save failed payload to disk to inspect
        const fs = require('fs');
        fs.writeFileSync('failed_gemini_payload.json', JSON.stringify({
          geminiBody: geminiBody,
          error: err
        }, null, 2));

        // If it's a 400 safety block, we shouldn't retry
        throw { status: res.status, data: err };
      }

      // Success
      await recordKeyUsage(keyObj.id);
      return res;
    } catch (err: any) {
      if (err.message === 'overloaded_error') throw err;
      if (err.status === 400) throw err; // Safety or bad request
      if (err.name === 'AbortError' || err.message?.includes('timeout')) {
        await reportKeyFailure(keyObj.id, false);
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw new Error('overloaded_error');
}
