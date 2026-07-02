export type RuntimePluginPermission = 'filesystem' | 'shell' | 'git' | 'browser' | 'http' | 'database' | 'mcp';

export interface RuntimePluginManifest {
  name: string;
  version: string;
  permissions: RuntimePluginPermission[];
}

export interface RuntimePlugin {
  manifest: RuntimePluginManifest;
  activate(container: DependencyInjectionContainer): Promise<void> | void;
  deactivate(): Promise<void> | void;
  executeCapability?(operation: string, input: Record<string, unknown>): Promise<unknown>;
}

export class DependencyInjectionContainer {
  private readonly services = new Map<string, unknown>();

  register<T>(token: string, service: T): void {
    this.services.set(token, service);
  }

  get<T>(token: string): T {
    const service = this.services.get(token);
    if (!service) {
      throw new Error(`Service token "${token}" is not registered in the DI container.`);
    }
    return service as T;
  }
}

export class RuntimePluginRegistry {
  private readonly plugins = new Map<string, RuntimePlugin>();
  private readonly container = new DependencyInjectionContainer();

  constructor() {}

  getContainer(): DependencyInjectionContainer {
    return this.container;
  }

  register(plugin: RuntimePlugin) {
    const key = `${plugin.manifest.name}@${plugin.manifest.version}`;
    this.plugins.set(key, plugin);
    return key;
  }

  async activateAll() {
    for (const plugin of this.plugins.values()) {
      await plugin.activate(this.container);
    }
  }

  async deactivateAll() {
    for (const plugin of this.plugins.values()) {
      await plugin.deactivate();
    }
  }

  /**
   * Safe execution wrapper that checks if the plugin manifests the required permission
   * before invoking a capability.
   */
  async executePluginCapability(
    pluginKey: string,
    permission: RuntimePluginPermission,
    operation: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    const plugin = this.plugins.get(pluginKey);
    if (!plugin) {
      throw new Error(`Plugin "${pluginKey}" is not registered.`);
    }

    if (!plugin.manifest.permissions.includes(permission)) {
      throw new Error(
        `Security Exception: Plugin "${plugin.manifest.name}" tried to execute "${operation}" which requires "${permission}" permission, but it only has permissions: [${plugin.manifest.permissions.join(', ')}]`
      );
    }

    if (!plugin.executeCapability) {
      throw new Error(`Plugin "${plugin.manifest.name}" does not implement executeCapability.`);
    }

    return plugin.executeCapability(operation, input);
  }

  list() {
    return Array.from(this.plugins.values()).map((plugin) => plugin.manifest);
  }
}
