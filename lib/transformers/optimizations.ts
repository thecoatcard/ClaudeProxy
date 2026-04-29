import { nanoid } from 'nanoid';

export interface OptimizationResult {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: any[];
  stop_reason: 'end_turn' | 'tool_use';
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Detects and handles "fast-path" Claude Code requests locally.
 */
export async function tryOptimizations(body: any): Promise<OptimizationResult | null> {
  const { messages, system, max_tokens, model, tool_choice, tools } = body;
  if (!messages || messages.length === 0) return null;

  const lastUserMessage = messages[messages.length - 1];
  if (lastUserMessage.role !== 'user') return null;

  const userText = extractText(lastUserMessage.content).toLowerCase();
  const systemText = extractText(system).toLowerCase();

  // 1. Quota Mocking
  if (max_tokens === 1 && userText.includes('quota')) {
    return createTextResponse(model, "Quota check passed.", 10, 5);
  }

  // 2. Title Generation Skip
  if (!body.tools && systemText.includes('title') && (
    systemText.includes('sentence-case title') || 
    (systemText.includes('return json') && (systemText.includes('coding session') || systemText.includes('this session')))
  )) {
    return createTextResponse(model, "Conversation", 100, 5);
  }

  // 3. Fast Prefix Detection
  if (userText.includes('<policy_spec>') && userText.includes('command:')) {
    const rawText = extractText(lastUserMessage.content);
    const cmdIndex = rawText.lastIndexOf('Command:');
    if (cmdIndex !== -1) {
      const command = rawText.slice(cmdIndex + 8).trim();
      const prefix = command.split(/\s+/)[0] || "";
      return createTextResponse(model, prefix, 100, 5);
    }
  }

  // 4. Suggestion Mode Skip
  if (userText.includes('[suggestion mode:')) {
    return createTextResponse(model, "", 100, 1);
  }

  // 5. Filepath Extraction Mock
  if (userText.includes('command:') && userText.includes('output:') && 
     (userText.includes('filepaths') || systemText.includes('extract any file paths'))) {
    const rawText = extractText(lastUserMessage.content);
    const outputIndex = rawText.indexOf('Output:');
    const output = rawText.slice(outputIndex + 7).trim();
    const pathRegex = /(?:[a-zA-Z]:\\|\/)[^:\s\n<>*?"|]+/g;
    const matches = Array.from(new Set(output.match(pathRegex) || []));
    return createTextResponse(model, matches.join('\n'), 100, 10);
  }

  // 6. Agentic Browsing (Local Tool Execution for web_search/web_fetch)
  // Only if forced via tool_choice
  if (tool_choice?.type === 'tool' && (tool_choice.name === 'web_search' || tool_choice.name === 'web_fetch')) {
    const toolName = tool_choice.name;
    const rawText = extractText(lastUserMessage.content);
    
    if (toolName === 'web_search') {
      const query = extractValue(rawText, ['query', 'search', 'q']) || rawText.slice(0, 50);
      const results = await performWebSearch(query);
      return createToolResponse(model, toolName, { query }, results);
    } else {
      const url = extractValue(rawText, ['url', 'href', 'link']) || (rawText.match(/https?:\/\/[^\s]+/)?.[0]);
      if (url) {
        const result = await performWebFetch(url);
        return createToolResponse(model, toolName, { url }, result);
      }
    }
  }

  return null;
}

function extractText(content: any): string {
  if (!content) return "";
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : c.text || "")).join("\n");
  }
  return "";
}

function extractValue(text: string, keys: string[]): string | null {
  for (const key of keys) {
    const regex = new RegExp(`${key}["'\\s:]+([^"'\\s\\n}]+)`, 'i');
    const match = text.match(regex);
    if (match) return match[1];
  }
  return null;
}

async function performWebSearch(query: string): Promise<string> {
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
    if (!res.ok) return "Search failed.";
    const html = await res.text();
    
    // Simple HTML parsing for DDG Lite results
    const results: string[] = [];
    const parts = html.split('result-link');
    for (const part of parts.slice(1, 6)) { // Get top 5
      const titleMatch = part.match(/>([^<]+)<\/a>/);
      const snippetMatch = part.match(/result-snippet">([^<]+)/);
      if (titleMatch) {
        results.push(`Title: ${titleMatch[1]}\nSnippet: ${snippetMatch ? snippetMatch[1] : 'No snippet.'}`);
      }
    }
    return results.length > 0 ? results.join('\n\n') : "No results found.";
  } catch (e) {
    return "Web search unavailable.";
  }
}

async function performWebFetch(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClaudeBot/1.0)' } });
    if (!res.ok) return `Failed to fetch URL: ${res.status}`;
    const text = await res.text();
    
    // Basic HTML to text conversion (stripping tags)
    const cleanText = text
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, "")
      .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
      
    return cleanText.slice(0, 10000); // Cap at 10k chars
  } catch (e) {
    return "Web fetch failed.";
  }
}

function createTextResponse(model: string, text: string, inputTokens: number, outputTokens: number): OptimizationResult {
  return {
    id: 'msg_' + nanoid(24),
    type: 'message',
    role: 'assistant',
    model: model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

function createToolResponse(model: string, toolName: string, input: any, result: string): OptimizationResult {
  const toolId = 'srvtoolu_' + nanoid(24);
  return {
    id: 'msg_' + nanoid(24),
    type: 'message',
    role: 'assistant',
    model: model,
    content: [
      {
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input: input
      },
      {
        type: 'text',
        text: `[Local Executor Result]:\n${result}`
      }
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: Math.ceil(result.length / 4)
    }
  };
}
