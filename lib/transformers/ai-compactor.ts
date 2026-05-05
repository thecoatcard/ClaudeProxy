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
        if (b.type === 'tool_result') return `[Result: ${JSON.stringify(b.content).slice(0, 200)}...]`;
        return `[${b.type}]`;
      }).join(' ');
    }
    return `${role}: ${content}`;
  }).join('\n\n');

  const prompt = `You are a conversation memory optimizer. Below is a middle section of a long technical conversation between a User and an AI Assistant.
The conversation includes tool calls and technical decisions.

TASK:
Summarize these turns into a highly concise "Memory Block" (max 250 words).
Focus on:
1. What the user asked for.
2. What technical decisions were made.
3. Key results from tool executions (success/failure, important data).
4. Any state that changed (files edited, variables set).

DO NOT include greetings or filler. Use bullet points for key facts.

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
    const summary = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return summary ? summary.trim() : null;
  } catch (error) {
    console.error('[AI-Compactor] Error during summarization:', error);
    return null;
  }
}
