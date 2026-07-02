import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSession, ArtifactRecord } from './contracts';

/**
 * Artifact storage directory, statically scoped to avoid Turbopack NFT tracing issues.
 * Resolves relative to the module location: <project-root>/.runtime-artifacts/
 */
const ARTIFACT_BASE_DIR = '.runtime-artifacts';

function getArtifactBaseDir(): string {
  // Use process.cwd() but scoped to a fixed subdirectory so Next.js
  // build analysis can correctly bound the filesystem access.
  return `${process.env.RUNTIME_ARTIFACT_DIR ?? process.cwd()}/${ARTIFACT_BASE_DIR}`;
}

/**
 * ArtifactManager stores, retrieves, and lists runtime artifacts produced during
 * agent execution (reports, plans, code diffs, summaries, etc.).
 *
 * DESIGN:
 * - Artifacts are persisted to disk under `.runtime-artifacts/<sessionId>/`.
 * - Session.artifacts tracks paths (not content) for lightweight in-memory state.
 * - retrieve() reads artifact content from disk on demand.
 * - list() returns all artifact records for a session.
 * - createWithContent() writes content and returns the full ArtifactRecord.
 *
 * All file I/O errors are caught and surfaced as structured errors rather than
 * crashing the runtime — artifact failures should never block session completion.
 */
export class ArtifactManager {
  private getSessionDir(sessionId: string): string {
    return path.join(getArtifactBaseDir(), sessionId);
  }

  private getArtifactPath(sessionId: string, artifactId: string, type: string): string {
    const ext = type === 'plan' ? 'json' : type === 'report' ? 'md' : 'txt';
    return path.join(this.getSessionDir(sessionId), `${artifactId}.${ext}`);
  }

  /**
   * Create a lightweight artifact record attached to the session.
   * Does NOT write to disk — use createWithContent() for persisted artifacts.
   */
  create(
    session: AgentSession,
    artifact: Omit<ArtifactRecord, 'id' | 'createdAt'>,
  ): ArtifactRecord {
    const record: ArtifactRecord = {
      id: randomUUID(),
      createdAt: Date.now(),
      ...artifact,
    };
    const artifactPath = artifact.path ?? `${record.type}:${record.label}`;
    record.path = artifactPath;
    if (!session.artifacts.includes(artifactPath)) {
      session.artifacts = [...session.artifacts, artifactPath];
    }
    return record;
  }

  /**
   * Create an artifact and persist its content to disk.
   * Returns the full ArtifactRecord including the resolved file path.
   *
   * Fails gracefully — if disk write fails, the artifact is still registered
   * in-session with an error flag so the terminal client can surface the issue.
   */
  async createWithContent(
    session: AgentSession,
    artifact: Omit<ArtifactRecord, 'id' | 'createdAt' | 'path'>,
    content: string,
  ): Promise<ArtifactRecord & { writeError?: string }> {
    const id = randomUUID();
    const sessionDir = this.getSessionDir(session.id);
    const filePath = this.getArtifactPath(session.id, id, artifact.type);

    let writeError: string | undefined;
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(filePath, content, 'utf8');
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error);
    }

    const record: ArtifactRecord & { writeError?: string } = {
      id,
      createdAt: Date.now(),
      path: filePath,
      writeError,
      ...artifact,
    };

    if (!session.artifacts.includes(filePath)) {
      session.artifacts = [...session.artifacts, filePath];
    }
    return record;
  }

  /**
   * Read the content of a stored artifact from disk.
   */
  async retrieve(sessionId: string, artifactId: string, type = 'report'): Promise<string | null> {
    try {
      const filePath = this.getArtifactPath(sessionId, artifactId, type);
      return await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * List all artifact files for a session directory.
   * Returns paths relative to the session artifact directory.
   */
  async list(sessionId: string): Promise<Array<{ id: string; path: string }>> {
    try {
      const sessionDir = this.getSessionDir(sessionId);
      const entries = await readdir(sessionDir);
      return entries
        .filter((entry) => !entry.startsWith('.'))
        .map((entry) => ({
          id: path.basename(entry, path.extname(entry)),
          path: path.join(sessionDir, entry),
        }));
    } catch {
      return [];
    }
  }

  /**
   * Returns the base directory where all runtime artifacts are stored.
   */
  artifactBaseDir(): string {
    return getArtifactBaseDir();
  }
}
