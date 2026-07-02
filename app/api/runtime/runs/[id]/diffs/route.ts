import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { dependencyError, runtimeOwner } from '../../http';
import { getAgentSessionRepository } from '@/lib/runtime/agent/session-service';

export const dynamic = 'force-dynamic';

/**
 * Run `git diff HEAD -- <file>` and return the output as a string.
 */
async function gitDiffFile(root: string, filePath: string, timeoutMs = 10_000): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const child = spawn('git', ['diff', 'HEAD', '--', filePath], {
      cwd: root,
      windowsHide: true,
      shell: false,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && stderr.join('').includes('not a git repository')) {
        resolve(null);
      } else {
        resolve(stdout.join(''));
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * GET /api/runtime/runs/[id]/diffs
 *
 * Returns git diffs for all files modified during a session.
 *
 * Query parameters:
 * - file: (optional) return diff for a single specific file only
 *
 * Response format:
 * {
 *   sessionId: string,
 *   workspace: string,
 *   modifiedFiles: string[],
 *   diffs: Array<{
 *     file: string,
 *     diff: string | null,  // null = git unavailable or file untracked
 *     hasChanges: boolean,
 *   }>
 * }
 *
 * The terminal client uses this to render syntax-highlighted diff views
 * without implementing any diff logic client-side.
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
  const specificFile = url.searchParams.get('file');

  try {
    const repository = await getAgentSessionRepository();
    const session = await repository.getAny(id);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const workspaceRoot = session.workspace.root;
    const modifiedFiles = specificFile
      ? [specificFile]
      : [...new Set(session.modifiedFiles)];

    if (modifiedFiles.length === 0) {
      return NextResponse.json({
        sessionId: id,
        workspace: workspaceRoot,
        modifiedFiles: [],
        diffs: [],
      });
    }

    // Generate diffs in parallel, capped at 10 files per request
    const filesToDiff = modifiedFiles.slice(0, 10);
    const diffs = await Promise.all(
      filesToDiff.map(async (filePath) => {
        const diff = await gitDiffFile(workspaceRoot, filePath);
        return {
          file: filePath,
          diff,
          hasChanges: diff !== null && diff.length > 0,
        };
      }),
    );

    return NextResponse.json({
      sessionId: id,
      workspace: workspaceRoot,
      modifiedFiles: session.modifiedFiles,
      truncated: modifiedFiles.length > 10,
      diffs,
    });
  } catch (error) {
    if ((error as Error).name === 'MongoConfigurationError') {
      return dependencyError();
    }
    throw error;
  }
}
