import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { getMongoDb } from '@/lib/mongodb';
import type {
  ToolAdapter,
  ToolContext,
  ToolInvocation,
  ToolResult,
  ToolAdapterKind,
} from './contracts';
import { McpRuntime } from './mcp-runtime';
import { resolveWorkspacePath } from './tool-paths';

function buildResult(
  status: ToolResult['status'],
  adapter: ToolAdapterKind,
  operation: string,
  startedAt: number,
  output?: Record<string, unknown>,
  error?: string,
  logs: string[] = [],
): ToolResult {
  const completedAt = Date.now();
  return {
    status,
    adapter,
    operation,
    output,
    error,
    logs,
    audit: {
      adapter,
      operation,
      permission: 'safe',
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
    },
  };
}

function throwIfCancelled(context: ToolContext) {
  context.cancellation?.throwIfCancelled();
}

async function runCommand(command: string, args: string[], context: ToolContext, timeoutMs: number) {
  throwIfCancelled(context);
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: context.workspaceRoot,
      windowsHide: true,
      shell: false,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        exitCode,
      });
    });
  });
}

export class FilesystemToolAdapter implements ToolAdapter {
  readonly kind = 'filesystem' as const;
  readonly operations = ['read', 'write', 'list', 'stat', 'mkdir', 'delete', 'move'];

  async execute(invocation: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const target = typeof invocation.input.path === 'string' ? invocation.input.path : '.';
      const absolutePath = resolveWorkspacePath(context.workspaceRoot, target);
      throwIfCancelled(context);

      switch (invocation.operation) {
        case 'read': {
          const content = await readFile(absolutePath, 'utf8');
          return buildResult('success', this.kind, invocation.operation, startedAt, { path: target, content });
        }
        case 'write': {
          const content = typeof invocation.input.content === 'string' ? invocation.input.content : '';
          await writeFile(absolutePath, content, 'utf8');
          return buildResult('success', this.kind, invocation.operation, startedAt, { path: target, bytes: content.length });
        }
        case 'list': {
          const entries = await readdir(absolutePath);
          return buildResult('success', this.kind, invocation.operation, startedAt, { path: target, entries });
        }
        case 'stat': {
          const fileStat = await stat(absolutePath);
          return buildResult('success', this.kind, invocation.operation, startedAt, {
            path: target,
            isDirectory: fileStat.isDirectory(),
            size: fileStat.size,
            modifiedAt: fileStat.mtimeMs,
          });
        }
        case 'mkdir': {
          await mkdir(absolutePath, { recursive: true });
          return buildResult('success', this.kind, invocation.operation, startedAt, { path: target });
        }
        case 'delete': {
          await rm(absolutePath, { recursive: true, force: true });
          return buildResult('success', this.kind, invocation.operation, startedAt, { path: target });
        }
        case 'move': {
          const destination = typeof invocation.input.destination === 'string' ? invocation.input.destination : '';
          const absoluteDestination = resolveWorkspacePath(context.workspaceRoot, destination);
          await rename(absolutePath, absoluteDestination);
          return buildResult('success', this.kind, invocation.operation, startedAt, { path: target, destination });
        }
        default:
          return buildResult('error', this.kind, invocation.operation, startedAt, undefined, `Unsupported filesystem operation: ${invocation.operation}`);
      }
    } catch (error) {
      return buildResult('error', this.kind, invocation.operation, startedAt, undefined, error instanceof Error ? error.message : String(error));
    }
  }
}

export class ShellToolAdapter implements ToolAdapter {
  readonly kind = 'shell' as const;
  readonly operations = ['exec'];

  /**
   * Shell injection patterns — blocked at execution time regardless of
   * how the command arrived (model response, MCP tool, plugin).
   * These are the most dangerous patterns that cannot be accidental.
   */
  private static readonly INJECTION_PATTERNS = [
    /:\s*\(\s*\)\s*\{.*\};\s*:\s*\(\s*\)/,    // fork bomb: :(){:|:&};:
    />\s*\/dev\/[sh]/i,                          // write to /dev/sda, /dev/shm
    /\|\s*xargs\s+rm/i,                          // pipe to destructive xargs
    /rm\s+(-[rf]+\s+)?\/\s*$/,                  // rm -rf /
    /`[^`]{1,512}`/,                             // backtick command substitution
    /\$\([^)]{1,512}\)/,                         // $() command substitution
    /eval\s+/i,                                  // eval usage
    /base64\s+.*\|\s*(bash|sh|zsh)/i,           // base64 decode and execute
    /curl\s+.*\|\s*(bash|sh)/i,                 // curl-pipe-to-shell
    /wget\s+.*\|\s*(bash|sh)/i,                 // wget-pipe-to-shell
    /python[23]?\s+-c\s+["']?import\s+os/i,    // python os.system injection
    /node\s+-e\s+["']?require\s*\(\s*['"]child_process/i, // node child_process injection
  ];

  private static sanitize(command: string): string {
    for (const pattern of ShellToolAdapter.INJECTION_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(`Shell command blocked: matches injection pattern ${pattern.source.slice(0, 40)}`);
      }
    }
    return command;
  }

  async execute(invocation: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const rawCommand = typeof invocation.input.command === 'string' ? invocation.input.command : '';
      const command = ShellToolAdapter.sanitize(rawCommand);
      const timeoutMs = typeof invocation.input.timeoutMs === 'number' ? invocation.input.timeoutMs : 30_000;
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
      const args = process.platform === 'win32' ? ['-Command', command] : ['-lc', command];
      const result = await runCommand(shell, args, context, timeoutMs);
      return buildResult(result.exitCode === 0 ? 'success' : 'error', this.kind, invocation.operation, startedAt, {
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }, result.exitCode === 0 ? undefined : `Shell command failed with exit code ${result.exitCode}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('timed out') ? 'timeout' : message.includes('blocked') ? 'error' : 'error';
      return buildResult(status, this.kind, invocation.operation, startedAt, undefined, message);
    }
  }
}


export class GitToolAdapter implements ToolAdapter {
  readonly kind = 'git' as const;
  readonly operations = ['status', 'diff', 'branch', 'log'];

  async execute(invocation: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const timeoutMs = typeof invocation.input.timeoutMs === 'number' ? invocation.input.timeoutMs : 20_000;
    const commandMap: Record<string, string[]> = {
      status: ['status', '--short', '--branch'],
      diff: ['diff', '--', ...(Array.isArray(invocation.input.paths) ? invocation.input.paths.map(String) : [])],
      branch: ['branch', '--show-current'],
      log: ['log', '--oneline', '-n', String(invocation.input.limit ?? 10)],
    };
    try {
      const args = commandMap[invocation.operation];
      if (!args) {
        return buildResult('error', this.kind, invocation.operation, startedAt, undefined, `Unsupported git operation: ${invocation.operation}`);
      }
      const result = await runCommand('git', args, context, timeoutMs);
      return buildResult(result.exitCode === 0 ? 'success' : 'error', this.kind, invocation.operation, startedAt, {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }, result.exitCode === 0 ? undefined : `Git command failed with exit code ${result.exitCode}`);
    } catch (error) {
      return buildResult('error', this.kind, invocation.operation, startedAt, undefined, error instanceof Error ? error.message : String(error));
    }
  }
}

export class BrowserToolAdapter implements ToolAdapter {
  readonly kind = 'browser' as const;
  readonly operations = ['fetch'];

  async execute(invocation: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      throwIfCancelled(context);
      const url = typeof invocation.input.url === 'string' ? invocation.input.url : '';
      const response = await fetch(url, { signal: AbortSignal.timeout(Number(invocation.input.timeoutMs ?? 10_000)) });
      const html = await response.text();
      return buildResult('success', this.kind, invocation.operation, startedAt, {
        url,
        status: response.status,
        contentType: response.headers.get('content-type'),
        html,
      });
    } catch (error) {
      return buildResult('error', this.kind, invocation.operation, startedAt, undefined, error instanceof Error ? error.message : String(error));
    }
  }
}

export class DockerToolAdapter implements ToolAdapter {
  readonly kind = 'docker' as const;
  readonly operations = ['ps', 'images', 'run'];

  async execute(invocation: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const timeoutMs = typeof invocation.input.timeoutMs === 'number' ? invocation.input.timeoutMs : 30_000;
      const args = invocation.operation === 'ps'
        ? ['ps']
        : invocation.operation === 'images'
          ? ['images']
          : invocation.operation === 'run' && typeof invocation.input.image === 'string'
            ? ['run', '--rm', invocation.input.image]
            : [];
      if (args.length === 0) {
        return buildResult('error', this.kind, invocation.operation, startedAt, undefined, `Unsupported docker operation: ${invocation.operation}`);
      }
      const result = await runCommand('docker', args, context, timeoutMs);
      return buildResult(result.exitCode === 0 ? 'success' : 'error', this.kind, invocation.operation, startedAt, {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }, result.exitCode === 0 ? undefined : `Docker command failed with exit code ${result.exitCode}`);
    } catch (error) {
      return buildResult('error', this.kind, invocation.operation, startedAt, undefined, error instanceof Error ? error.message : String(error));
    }
  }
}

export class DatabaseToolAdapter implements ToolAdapter {
  readonly kind = 'database' as const;
  readonly operations = ['find', 'insertOne', 'updateOne'];

  async execute(invocation: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      throwIfCancelled(context);
      const db = await getMongoDb();
      const collectionName = typeof invocation.input.collection === 'string' ? invocation.input.collection : '';
      if (!collectionName) {
        return buildResult('error', this.kind, invocation.operation, startedAt, undefined, 'Collection is required');
      }
      const collection = db.collection(collectionName);

      switch (invocation.operation) {
        case 'find': {
          const filter = typeof invocation.input.filter === 'object' && invocation.input.filter ? invocation.input.filter as Record<string, unknown> : {};
          const limit = Number(invocation.input.limit ?? 20);
          const docs = await collection.find(filter).limit(limit).toArray();
          return buildResult('success', this.kind, invocation.operation, startedAt, { documents: docs });
        }
        case 'insertOne': {
          const document = typeof invocation.input.document === 'object' && invocation.input.document ? invocation.input.document as Record<string, unknown> : {};
          const result = await collection.insertOne(document);
          return buildResult('success', this.kind, invocation.operation, startedAt, { insertedId: String(result.insertedId) });
        }
        case 'updateOne': {
          const filter = typeof invocation.input.filter === 'object' && invocation.input.filter ? invocation.input.filter as Record<string, unknown> : {};
          const update = typeof invocation.input.update === 'object' && invocation.input.update ? invocation.input.update as Record<string, unknown> : {};
          const result = await collection.updateOne(filter, update);
          return buildResult('success', this.kind, invocation.operation, startedAt, { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
        }
        default:
          return buildResult('error', this.kind, invocation.operation, startedAt, undefined, `Unsupported database operation: ${invocation.operation}`);
      }
    } catch (error) {
      return buildResult('error', this.kind, invocation.operation, startedAt, undefined, error instanceof Error ? error.message : String(error));
    }
  }
}

export class HttpToolAdapter implements ToolAdapter {
  readonly kind = 'http' as const;
  readonly operations = ['request'];

  async execute(invocation: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      throwIfCancelled(context);
      const url = typeof invocation.input.url === 'string' ? invocation.input.url : '';
      const method = typeof invocation.input.method === 'string' ? invocation.input.method.toUpperCase() : 'GET';
      const response = await fetch(url, {
        method,
        headers: typeof invocation.input.headers === 'object' && invocation.input.headers ? invocation.input.headers as HeadersInit : undefined,
        body: typeof invocation.input.body === 'string' ? invocation.input.body : undefined,
        signal: AbortSignal.timeout(Number(invocation.input.timeoutMs ?? 15_000)),
      });
      const text = await response.text();
      return buildResult('success', this.kind, invocation.operation, startedAt, {
        url,
        method,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: text,
      });
    } catch (error) {
      return buildResult('error', this.kind, invocation.operation, startedAt, undefined, error instanceof Error ? error.message : String(error));
    }
  }
}

export class McpToolAdapter implements ToolAdapter {
  readonly kind = 'mcp' as const;
  readonly operations = ['tool', 'resource', 'prompt'];

  constructor(private readonly runtime: McpRuntime) {}

  async execute(invocation: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      throwIfCancelled(context);
      if (invocation.operation === 'tool') {
        const name = typeof invocation.input.name === 'string' ? invocation.input.name : '';
        const input = typeof invocation.input.input === 'object' && invocation.input.input ? invocation.input.input as Record<string, unknown> : {};
        const result = await this.runtime.invokeTool(name, input);
        return buildResult('success', this.kind, invocation.operation, startedAt, { result: result as unknown as Record<string, unknown> });
      }
      if (invocation.operation === 'resource') {
        const uri = typeof invocation.input.uri === 'string' ? invocation.input.uri : '';
        const result = await this.runtime.readResource(uri);
        return buildResult('success', this.kind, invocation.operation, startedAt, { result: result as unknown as Record<string, unknown> });
      }
      if (invocation.operation === 'prompt') {
        const name = typeof invocation.input.name === 'string' ? invocation.input.name : '';
        const input = typeof invocation.input.input === 'object' && invocation.input.input ? invocation.input.input as Record<string, unknown> : {};
        const result = await this.runtime.renderPrompt(name, input);
        return buildResult('success', this.kind, invocation.operation, startedAt, { text: result });
      }
      return buildResult('error', this.kind, invocation.operation, startedAt, undefined, `Unsupported MCP operation: ${invocation.operation}`);
    } catch (error) {
      return buildResult('error', this.kind, invocation.operation, startedAt, undefined, error instanceof Error ? error.message : String(error));
    }
  }
}

export function createRuntimeToolAdapters(mcpRuntime: McpRuntime): ToolAdapter[] {
  return [
    new FilesystemToolAdapter(),
    new ShellToolAdapter(),
    new GitToolAdapter(),
    new BrowserToolAdapter(),
    new DockerToolAdapter(),
    new DatabaseToolAdapter(),
    new HttpToolAdapter(),
    new McpToolAdapter(mcpRuntime),
  ];
}
