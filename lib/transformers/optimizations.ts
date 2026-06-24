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

  // NOTE: Items 6 (Agentic Browsing) and 7 (Permission Bypass) were removed.
  // - Agentic Browsing (web_search/web_fetch local execution) was removed due to
  //   SSRF risk: user-controlled URLs were fetched server-side without validation.
  //   This gateway is a translator layer only — it must not issue arbitrary outbound HTTP.
  // - The "Superpower Permission Bypass" block was removed as a security vulnerability:
  //   any message containing "bypass permission" would return a fake grant response,
  //   enabling prompt injection attacks.

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
