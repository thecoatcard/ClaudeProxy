import { NextResponse } from 'next/server';
import { extractToken, validateUserKey, validateAdminKey } from '@/lib/auth';

export async function GET(req: Request) {
  const token = extractToken(req);
  if (!token) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } }, { status: 401 });
  }
  
  const isValid = await validateUserKey(token) || validateAdminKey(req);
  if (!isValid) {
    return NextResponse.json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } }, { status: 401 });
  }

  return NextResponse.json({
    object: "list",
    data: [
      { id: "claude-opus-4-5-20251101",   type: "model", display_name: "Claude Opus 4.5" },
      { id: "claude-sonnet-4-5-20250929", type: "model", display_name: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5-20251001",  type: "model", display_name: "Claude Haiku 4.5" },
      { id: "claude-opus-4",    type: "model", display_name: "Claude Opus 4.5" },
      { id: "claude-sonnet-4", type: "model", display_name: "Claude Sonnet 4.5" },
      { id: "claude-haiku",  type: "model", display_name: "Claude Haiku 4.5" },
      { id: "gemma-4-31b-it", type: "model", display_name: "Gemma 4 31B IT" },
      { id: "gemma-4-26b-a4b-it", type: "model", display_name: "Gemma 4 26B A4B IT" },
      { id: "gemini-2.5-flash-lite", type: "model", display_name: "Gemini 2.5 Flash Lite" },
      { id: "gemini-2.5-flash", type: "model", display_name: "Gemini 2.5 Flash" },
      { id: "gemini-3.1-flash-lite-preview", type: "model", display_name: "Gemini 3.1 Flash Lite Preview" },
      { id: "gemini-flash-latest", type: "model", display_name: "Gemini Flash Latest" },
      { id: "gemini-flash-lite-latest", type: "model", display_name: "Gemini Flash Lite Latest" },
      { id: "gemini-3-flash-preview", type: "model", display_name: "Gemini 3 Flash Preview" }
    ]
  });
}
