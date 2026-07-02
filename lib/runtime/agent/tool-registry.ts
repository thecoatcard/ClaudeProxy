import type { ToolAdapter, ToolAdapterKind, ToolCapability, ToolDefinition, ToolInvocation } from './contracts';
import { PermissionManager } from './permission-manager';

type ToolRequest = {
  name?: string;
};

type RuntimeRequestBody = {
  tools?: ToolRequest[];
};

export class ToolRegistry {
  private readonly adapters = new Map<ToolAdapterKind, ToolAdapter>();
  private readonly definitions = new Map<string, ToolDefinition>();

  constructor(private readonly permissions: PermissionManager, adapters: ToolAdapter[] = []) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.kind, adapter);
      for (const operation of adapter.operations) {
        const name = `${adapter.kind}_${operation}`;
        this.definitions.set(name, {
          name,
          description: `${adapter.kind} ${operation} operation managed by the agent runtime`,
          adapter: adapter.kind,
          operation,
          permission: this.permissions.classify(`${adapter.kind}:${operation}`),
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        });
      }
    }
    this.registerAliases();
  }

  register(adapter: ToolAdapter) {
    this.adapters.set(adapter.kind, adapter);
  }

  private registerAlias(name: string, adapter: ToolAdapterKind, operation: string, description: string, inputSchema: Record<string, unknown>) {
    this.definitions.set(name, {
      name,
      description,
      adapter,
      operation,
      permission: this.permissions.classify(`${adapter}:${operation}`),
      inputSchema,
    });
  }

  private registerAliases() {
    const pathSchema = { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: true };
    const writeSchema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      additionalProperties: true,
    };
    const shellSchema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: true,
    };
    this.registerAlias('Read', 'filesystem', 'read', 'Read a file from the active workspace.', pathSchema);
    this.registerAlias('Write', 'filesystem', 'write', 'Write a full file in the active workspace.', writeSchema);
    this.registerAlias('LS', 'filesystem', 'list', 'List files in a directory in the active workspace.', pathSchema);
    this.registerAlias('Stat', 'filesystem', 'stat', 'Inspect a file or directory in the active workspace.', pathSchema);
    this.registerAlias('Mkdir', 'filesystem', 'mkdir', 'Create a directory in the active workspace.', pathSchema);
    this.registerAlias('Delete', 'filesystem', 'delete', 'Delete a file or directory in the active workspace.', pathSchema);
    this.registerAlias('Move', 'filesystem', 'move', 'Move or rename a file in the active workspace.', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        destination: { type: 'string' },
      },
      additionalProperties: true,
    });
    this.registerAlias('Bash', 'shell', 'exec', 'Execute a shell command in the active workspace.', shellSchema);
    this.registerAlias('Shell', 'shell', 'exec', 'Execute a shell command in the active workspace.', shellSchema);
    this.registerAlias('GitStatus', 'git', 'status', 'Inspect current git status.', { type: 'object', properties: {}, additionalProperties: true });
    this.registerAlias('GitDiff', 'git', 'diff', 'Inspect git diff for workspace files.', { type: 'object', properties: { paths: { type: 'array' } }, additionalProperties: true });
    this.registerAlias('GitBranch', 'git', 'branch', 'Inspect the current git branch.', { type: 'object', properties: {}, additionalProperties: true });
    this.registerAlias('GitLog', 'git', 'log', 'Inspect recent git history.', { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: true });
    this.registerAlias('Fetch', 'http', 'request', 'Send an HTTP request.', {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string' },
      },
      additionalProperties: true,
    });
  }

  get(kind: ToolAdapterKind) {
    return this.adapters.get(kind) ?? null;
  }

  listCapabilities() {
    return Array.from(this.adapters.values()).map<ToolCapability>((adapter) => ({
      name: adapter.kind,
      source: 'runtime',
      permission: this.permissions.classify(adapter.kind),
      enabled: true,
      operations: adapter.operations,
    }));
  }

  build(body: RuntimeRequestBody): ToolCapability[] {
    const runtimeTools = this.listCapabilities();
    const requested = (Array.isArray(body?.tools) ? body.tools : []).map((tool) => {
      const name = typeof tool?.name === 'string' ? tool.name : 'unknown';
      const runtime = this.adapters.get(name as ToolAdapterKind);
      return {
        name,
        source: 'request' as const,
        permission: this.permissions.classify(name),
        enabled: name !== 'unknown' && Boolean(runtime),
        operations: runtime?.operations ?? [],
      };
    });

    return [...runtimeTools, ...requested];
  }

  listDefinitions() {
    return Array.from(this.definitions.values());
  }

  anthropicToolSchemas() {
    return this.listDefinitions().map((definition) => ({
      name: definition.name,
      description: definition.description,
      input_schema: definition.inputSchema,
    }));
  }

  resolveToolCall(name: string, input: Record<string, unknown>): ToolInvocation | null {
    const definition = this.definitions.get(name);
    if (!definition) {
      if (name.startsWith('mcp__')) {
        return {
          adapter: 'mcp',
          operation: 'tool',
          input: {
            name,
            input,
          },
        };
      }
      return null;
    }
    const normalizedInput = { ...input };
    if (definition.adapter === 'filesystem') {
      if (typeof normalizedInput.file_path === 'string' && typeof normalizedInput.path !== 'string') {
        normalizedInput.path = normalizedInput.file_path;
      }
      if (typeof normalizedInput.dir_path === 'string' && typeof normalizedInput.path !== 'string') {
        normalizedInput.path = normalizedInput.dir_path;
      }
      if (typeof normalizedInput.new_path === 'string' && typeof normalizedInput.destination !== 'string') {
        normalizedInput.destination = normalizedInput.new_path;
      }
    }
    if (definition.adapter === 'shell') {
      if (typeof normalizedInput.cmd === 'string' && typeof normalizedInput.command !== 'string') {
        normalizedInput.command = normalizedInput.cmd;
      }
    }
    return {
      adapter: definition.adapter,
      operation: definition.operation,
      input: normalizedInput,
    };
  }
}
