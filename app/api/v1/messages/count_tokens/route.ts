import { NextResponse } from 'next/server';
import { countTokens } from '@/lib/tokenizer';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    let text = '';
    
    if (body.system) {
       text += typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
    }
    
    for (const msg of body.messages || []) {
      if (typeof msg.content === 'string') {
        text += msg.content;
      } else if (Array.isArray(msg.content)) {
        text += JSON.stringify(msg.content);
      }
    }
    
    if (body.tools) {
      text += JSON.stringify(body.tools);
    }

    return NextResponse.json({ input_tokens: countTokens(text) });
  } catch (err) {
    return NextResponse.json({ input_tokens: 0 });
  }
}
