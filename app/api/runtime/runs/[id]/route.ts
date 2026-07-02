import { NextResponse } from 'next/server';
import { dependencyError, runtimeOwner, sessionToRun } from '../http';
import { getAgentSessionRepository } from '@/lib/runtime/agent/session-service';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = await runtimeOwner(req);
  if (!ownerId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;
  try {
    const repository = await getAgentSessionRepository();
    const session = await repository.getAny(id);
    if (!session) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ run: sessionToRun(session) });
  } catch (error) {
    if ((error as Error).name === 'MongoConfigurationError') {
      return dependencyError();
    }
    throw error;
  }
}
