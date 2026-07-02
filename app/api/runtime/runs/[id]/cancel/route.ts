import { NextResponse } from 'next/server';
import { dependencyError, runtimeOwner, sessionToRun } from '../../http';
import { getAgentSessionRepository } from '@/lib/runtime/agent/session-service';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = await runtimeOwner(req);
  if (!ownerId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;
  const ifMatch = req.headers.get('if-match');
  const expectedVersion = ifMatch ? Number(ifMatch.replace(/"/g, '')) : undefined;
  if (ifMatch && !Number.isFinite(expectedVersion)) {
    return NextResponse.json({ error: 'Invalid If-Match header' }, { status: 400 });
  }

  try {
    const repository = await getAgentSessionRepository();
    const session = await repository.requestCancellationAny(id, expectedVersion);
    if (!session) {
      return NextResponse.json({ error: 'Conflict' }, { status: 409 });
    }
    return NextResponse.json({ run: sessionToRun(session) });
  } catch (error) {
    if ((error as Error).name === 'MongoConfigurationError') {
      return dependencyError();
    }
    throw error;
  }
}
