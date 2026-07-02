import { NextResponse } from 'next/server';
import { dependencyError, runtimeOwner } from '../../http';
import { getAgentSessionRepository } from '@/lib/runtime/agent/session-service';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = await runtimeOwner(req);
  if (!ownerId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;
  const url = new URL(req.url);
  const afterSequence = Number(url.searchParams.get('after') ?? req.headers.get('last-event-id') ?? 0);
  if (!Number.isFinite(afterSequence) || afterSequence < 0) {
    return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
  }

  try {
    const repository = await getAgentSessionRepository();
    const events = await repository.eventsAny(id, afterSequence);
    const lines = events.map((event) => `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return new Response(`: connected\n\n${lines.join('')}`, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    if ((error as Error).name === 'MongoConfigurationError') {
      return dependencyError();
    }
    throw error;
  }
}
