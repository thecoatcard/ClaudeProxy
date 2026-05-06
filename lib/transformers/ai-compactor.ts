import { callGemini } from '../gemini-adapter';

/**
 * Uses Gemini to generate a semantic summary of removed conversation turns.
 */
export async function generateSemanticSummary(
  removedMessages: any[],
  apiKey: string,
  model: string = 'gemma-4-31b-it'
): Promise<string | null> {
  if (!removedMessages || removedMessages.length === 0) return null;

  // Format messages for the summarizer model
  const historyText = removedMessages.map(msg => {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    let content = "";
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map((b: any) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_use') return `[Action: ${b.name}]`;
        if (b.type === 'tool_result') {
          const resultStr = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          // Allow up to 15,000 characters for Gemma 4 to analyze (approx 4k tokens)
          return `[Tool Output: ${resultStr.length > 15000 ? resultStr.slice(0, 15000) + '... (truncated for summary)' : resultStr}]`;
        }
        return `[${b.type}]`;
      }).join(' ');
    }
    return `${role}: ${content}`;
  }).join('\n\n');

  const prompt = `You are a conversation memory optimizer. Below is a middle section of a technical conversation.
It contains large data outputs from tools (logs, file contents, command results).

TASK:
Summarize these turns into a concise "Memory Block" (max 300 words).

CRITICAL INSTRUCTIONS:
1. For LARGE tool outputs, do not just say "tool returned data". Analyze the data and explain what it means (e.g., "The logs show a null pointer at line 42" or "The search returned 5 files, only index.ts was relevant").
2. Preserve all technical decisions, file paths, and specific constants mentioned.
3. If a tool failed, explain why based on the output.

CONVERSATION TO SUMMARIZE:
${historyText}

SUMMARY:`;

  const body = {
    contents: [{
      role: 'user',
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      maxOutputTokens: 500,
      temperature: 0.3,
    }
  };

  try {
    const res = await callGemini(model, apiKey, body, false);
    if (!res.ok) {
      console.warn(`[AI-Compactor] Summarization failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    // Find the first text part, as reasoning models might return 'thought' parts first
    const textPart = parts.find((p: any) => p && typeof p.text === 'string' && p.text.trim());
    const summary = textPart?.text;
    return summary ? summary.trim() : null;
  } catch (error) {
    console.error('[AI-Compactor] Error during summarization:', error);
    return null;
  }
}
