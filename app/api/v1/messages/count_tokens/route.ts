import { NextResponse } from 'next/server';
import { extractToken, validateUserKey } from '@/lib/auth';
import { countTokens } from '@/lib/tokenizer';

// Node.js runtime required for ioredis

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Allow': 'POST, OPTIONS, HEAD',
      'Anthropic-Version': '2023-06-01',
    },
  });
}

export async function HEAD() {
  return new Response(null, {
    status: 204,
    headers: {
      'Allow': 'POST, OPTIONS, HEAD',
      'Anthropic-Version': '2023-06-01',
    },
  });
}

/**
 * POST /v1/messages/count_tokens
 *
 * Anthropic spec: https://docs.anthropic.com/en/api/counting-tokens
 * Claude Code calls this before every large request to pre-flight context size.
 *
 * Response shape: { input_tokens: number }
 */
export async function POST(req: Request) {
  // Auth — same rules as the main /v1/messages endpoint.
  const token = extractToken(req);
  if (!token) {
    return NextResponse.json(
      { type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } },
      { status: 401 }
    );
  }
  const isValid = await validateUserKey(token);
  if (!isValid) {
    return NextResponse.json(
      { type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } },
      { status: 401 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } },
      { status: 400 }
    );
  }

  let text = '';

  // System prompt
  if (body.system) {
    if (typeof body.system === 'string') {
      text += body.system;
    } else if (Array.isArray(body.system)) {
      for (const s of body.system) {
        if (typeof s === 'string') text += s;
        else if (s?.text) text += s.text;
      }
    } else {
      text += JSON.stringify(body.system);
    }
  }

  // Messages
  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') {
      text += msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'string') {
          text += block;
        } else if (block?.type === 'text') {
          text += block.text || '';
        } else if (block?.type === 'thinking') {
          text += block.thinking || '';
        } else if (block?.type === 'tool_use') {
          text += block.name || '';
          text += JSON.stringify(block.input || {});
        } else if (block?.type === 'tool_result') {
          if (typeof block.content === 'string') {
            text += block.content;
          } else if (Array.isArray(block.content)) {
            for (const c of block.content) {
              if (c?.type === 'text') text += c.text || '';
              // Images: estimate ~85 tokens per image (Anthropic's heuristic)
              // by adding 340 chars worth of placeholder.
              else if (c?.type === 'image') text += ' '.repeat(340);
            }
          }
        } else if (block?.type === 'image') {
          // Base64 images: rough estimate using data length / ~1200 chars per token
          const dataLen = block?.source?.data?.length || 0;
          text += ' '.repeat(Math.ceil(dataLen / 1200) * 4);
        } else {
          try { text += JSON.stringify(block); } catch { /* skip */ }
        }
      }
    }
  }

  // Tool definitions contribute to the prompt token count.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    text += JSON.stringify(body.tools);
  }

  return NextResponse.json({ input_tokens: countTokens(text) });
}
