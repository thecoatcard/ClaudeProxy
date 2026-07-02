export interface McpToolDefinition {
  name: string;
  description: string;
  handler: (input: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface McpResourceDefinition {
  uri: string;
  loader: () => Promise<unknown> | unknown;
}

export interface McpPromptDefinition {
  name: string;
  render: (input: Record<string, unknown>) => Promise<string> | string;
}

export class McpRuntime {
  private readonly tools = new Map<string, McpToolDefinition>();
  private readonly resources = new Map<string, McpResourceDefinition>();
  private readonly prompts = new Map<string, McpPromptDefinition>();

  registerTool(definition: McpToolDefinition) {
    this.tools.set(definition.name, definition);
  }

  registerResource(definition: McpResourceDefinition) {
    this.resources.set(definition.uri, definition);
  }

  registerPrompt(definition: McpPromptDefinition) {
    this.prompts.set(definition.name, definition);
  }

  async invokeTool(name: string, input: Record<string, unknown>) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    return tool.handler(input);
  }

  async readResource(uri: string) {
    const resource = this.resources.get(uri);
    if (!resource) throw new Error(`Unknown MCP resource: ${uri}`);
    return resource.loader();
  }

  async renderPrompt(name: string, input: Record<string, unknown>) {
    const prompt = this.prompts.get(name);
    if (!prompt) throw new Error(`Unknown MCP prompt: ${name}`);
    return prompt.render(input);
  }

  summary() {
    return {
      tools: Array.from(this.tools.keys()).sort(),
      resources: Array.from(this.resources.keys()).sort(),
      prompts: Array.from(this.prompts.keys()).sort(),
    };
  }

  /**
   * Bootstrap MCP tools from environment configuration.
   *
   * Reads the MCP_TOOLS_JSON environment variable (a JSON array of tool definitions)
   * and registers each tool. This enables external MCP tool providers to be configured
   * without code changes.
   *
   * Environment format (MCP_TOOLS_JSON):
   * [{ "name": "my_tool", "description": "...", "endpoint": "http://..." }]
   */
  async bootstrap(): Promise<void> {
    const toolsJson = process.env.MCP_TOOLS_JSON?.trim();
    if (!toolsJson) return;

    let toolConfigs: Array<{ name: string; description?: string; endpoint?: string }>;
    try {
      toolConfigs = JSON.parse(toolsJson);
    } catch {
      console.warn('[McpRuntime] Failed to parse MCP_TOOLS_JSON:', toolsJson.slice(0, 100));
      return;
    }

    for (const config of toolConfigs) {
      if (!config.name || typeof config.name !== 'string') continue;

      if (config.endpoint) {
        // Register as an HTTP-based remote MCP tool
        const endpoint = config.endpoint;
        this.registerTool({
          name: config.name,
          description: config.description ?? `MCP tool: ${config.name}`,
          handler: async (input: Record<string, unknown>) => {
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(input),
              signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) {
              throw new Error(`MCP tool "${config.name}" returned HTTP ${response.status}`);
            }
            return response.json() as Promise<unknown>;
          },
        });
      }
    }

    if (toolConfigs.length > 0) {
      console.info(`[McpRuntime] Bootstrapped ${this.tools.size} MCP tool(s)`);
    }
  }
}

