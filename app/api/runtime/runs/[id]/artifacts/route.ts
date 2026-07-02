import { NextResponse } from 'next/server';
import path from 'node:path';
import { dependencyError, runtimeOwner } from '../../http';
import { getAgentSessionRepository } from '@/lib/runtime/agent/session-service';
import { ArtifactManager } from '@/lib/runtime/agent/artifact-manager';

export const dynamic = 'force-dynamic';

const artifactManager = new ArtifactManager();

/**
 * GET /api/runtime/runs/[id]/artifacts
 *
 * Returns all artifact records for a session.
 * Each record includes the artifact ID, path, type, label, and metadata.
 * The content is NOT inlined by default (use ?content=true for small artifacts).
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const ownerId = await runtimeOwner(req);
  if (!ownerId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;
  const url = new URL(req.url);
  const includeContent = url.searchParams.get('content') === 'true';
  const artifactId = url.searchParams.get('artifactId');

  try {
    const repository = await getAgentSessionRepository();
    const session = await repository.getAny(id);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Single artifact retrieval
    if (artifactId) {
      const content = await artifactManager.retrieve(session.id, artifactId);
      if (content === null) {
        return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
      }
      return NextResponse.json({ artifactId, content });
    }

    // List all artifacts for the session
    const diskArtifacts = await artifactManager.list(session.id);

    const artifacts = await Promise.all(
      diskArtifacts.map(async (entry) => {
        const ext = path.extname(entry.path).slice(1);
        const type = ext === 'md' ? 'report' : ext === 'json' ? 'plan' : 'text';
        let content: string | undefined;
        if (includeContent) {
          content = (await artifactManager.retrieve(session.id, entry.id)) ?? undefined;
        }
        return {
          id: entry.id,
          sessionId: session.id,
          path: entry.path,
          type,
          ...(content !== undefined ? { content } : {}),
        };
      }),
    );

    // Also include session.artifacts paths that may not have disk entries
    const allPaths = new Set([
      ...artifacts.map((a) => a.path),
      ...session.artifacts,
    ]);

    return NextResponse.json({
      sessionId: id,
      count: allPaths.size,
      artifacts: artifacts.length > 0 ? artifacts : session.artifacts.map((artifactPath) => ({
        id: path.basename(artifactPath, path.extname(artifactPath)),
        sessionId: session.id,
        path: artifactPath,
        type: 'unknown',
      })),
    });
  } catch (error) {
    if ((error as Error).name === 'MongoConfigurationError') {
      return dependencyError();
    }
    throw error;
  }
}
