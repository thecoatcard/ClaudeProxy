import { access } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceContext } from './contracts';

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dangerous shell patterns that must never be executed as-is.
 * This list covers the most common shell injection / destruction vectors.
 */
const SHELL_INJECTION_PATTERNS: RegExp[] = [
  /;\s*(rm|del|rmdir)\s+-rf?\s+[/\\*]/i,           // rm -rf / or del /
  /`[^`]+`/,                                          // backtick command substitution
  /\$\([^)]+\)/,                                      // $( ) command substitution
  /&&\s*rm\s+-rf?/i,                                  // chained destructive commands
  /\|\|\s*rm\s+-rf?/i,
  />\s*\/dev\/sd[a-z]/i,                              // write to raw block device
  /dd\s+if=/i,                                        // disk copy / wipe
  /mkfs\./i,                                          // format disk
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,          // fork bomb
  /\beval\s+["'`]/i,                                  // eval injection
];

export class WorkspaceManager {
  private readonly fileLocks = new Map<string, Promise<void>>();

  /**
   * Acquire a lock for a given file path.
   * Resolves when the lock is successfully acquired.
   */
  async acquireFileLock(filePath: string): Promise<() => void> {
    const normalized = path.normalize(filePath);
    const existing = this.fileLocks.get(normalized) ?? Promise.resolve();

    let releaseLock: () => void = () => {};
    const newLock = new Promise<void>((resolve) => {
      releaseLock = () => {
        if (this.fileLocks.get(normalized) === newLock) {
          this.fileLocks.delete(normalized);
        }
        resolve();
      };
    });

    this.fileLocks.set(normalized, newLock);
    await existing;
    return releaseLock;
  }

  /**
   * Verify that the path is contained safely within the workspace root.
   * Throws an error if a path traversal attempt is detected.
   */
  validateSandboxPath(root: string, targetPath: string): string {
    const absoluteRoot = path.resolve(root);
    const absoluteTarget = path.resolve(absoluteRoot, targetPath);
    if (!absoluteTarget.startsWith(absoluteRoot + path.sep) && absoluteTarget !== absoluteRoot) {
      throw new Error(`Sandbox escape attempt detected: "${targetPath}" is outside root "${root}"`);
    }
    return absoluteTarget;
  }

  /**
   * Validates that a shell command string does not contain known injection patterns.
   * Throws a descriptive error if an injection vector is detected.
   *
   * Used by ValidationEngine before invoking any shell-based validation command.
   */
  sanitizeShellCommand(command: string): void {
    for (const pattern of SHELL_INJECTION_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(
          `Shell command rejected: contains a potentially dangerous pattern. Command: "${command.slice(0, 80)}..."`,
        );
      }
    }
  }

  /**
   * Validate and sanitize a build/test command from package.json.
   * Returns the command if safe, throws if not.
   */
  validatePackageCommand(command: string | undefined): string | undefined {
    if (!command) return undefined;
    this.sanitizeShellCommand(command);
    return command;
  }

  async initialize(): Promise<WorkspaceContext> {
    const root = process.cwd();
    const packageManager = await exists(path.join(root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : await exists(path.join(root, 'yarn.lock'))
        ? 'yarn'
        : await exists(path.join(root, 'package-lock.json'))
          ? 'npm'
          : 'unknown';
    const framework = await exists(path.join(root, 'app'))
      ? 'nextjs'
      : 'unknown';
    const language = await exists(path.join(root, 'tsconfig.json')) ? 'typescript' : 'javascript';

    const rawBuildCommand = packageManager === 'unknown' ? undefined : `${packageManager === 'npm' ? 'npm run' : packageManager} build`;
    const rawTestCommand = packageManager === 'unknown' ? undefined : `${packageManager === 'npm' ? 'npm run' : packageManager} test`;

    return {
      root,
      packageManager,
      projectType: framework === 'nextjs' ? 'nextjs-api-gateway' : 'application',
      language,
      framework,
      buildCommand: this.validatePackageCommand(rawBuildCommand),
      testCommand: this.validatePackageCommand(rawTestCommand),
      configFiles: ['package.json', 'tsconfig.json', 'next.config.ts', 'next.config.js'],
      entryPoints: ['app/api/v1/messages/route.ts', 'lib/runtime/agent/messages-runtime.ts'],
    };
  }
}
