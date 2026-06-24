// Shared parser for Gemini action-style tool text:
// [Action: I am calling tool <name> with arguments: {...}]
// We only recover when the JSON object is fully parseable.

export interface ActionRecovery {
  toolName: string;
  args: any;
  start: number;
  end: number;
  raw: string;
}

const ACTION_HEAD_RE = /\[\s*Action\s*:\s*I\s+am\s+calling\s+tool\s+/i;

function findBalancedJSONObject(text: string, from: number): { json: string; end: number } | null {
  const open = text.indexOf('{', from);
  if (open < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = open; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return { json: text.slice(open, i + 1), end: i + 1 };
      }
    }
  }

  return null;
}

export function recoverActionText(text: string): ActionRecovery | null {
  if (!text) return null;
  const head = ACTION_HEAD_RE.exec(text);
  if (!head || head.index == null) return null;

  const start = head.index;
  let cursor = start + head[0].length;

  // Optional quote/backtick around tool name.
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++;

  let toolName = '';
  const q = text[cursor];
  if (q === '`' || q === '"' || q === "'") {
    const close = text.indexOf(q, cursor + 1);
    if (close < 0) return null;
    toolName = text.slice(cursor + 1, close).trim();
    cursor = close + 1;
  } else {
    const nameMatch = /([^\s\]]+)/.exec(text.slice(cursor));
    if (!nameMatch) return null;
    toolName = nameMatch[1].trim();
    cursor += nameMatch[0].length;
  }
  if (!toolName) return null;

  const argsLabel = /\bwith\s+arguments\s*:\s*/i.exec(text.slice(cursor));
  if (!argsLabel || argsLabel.index == null) return null;
  const argsStart = cursor + argsLabel.index + argsLabel[0].length;

  const parsedObj = findBalancedJSONObject(text, argsStart);
  if (!parsedObj) return null;

  let args: any;
  try {
    args = JSON.parse(parsedObj.json);
  } catch {
    return null;
  }

  let end = parsedObj.end;
  while (end < text.length && /\s/.test(text[end])) end++;
  if (text[end] === ']') end++;

  return {
    toolName,
    args,
    start,
    end,
    raw: text.slice(start, end)
  };
}
