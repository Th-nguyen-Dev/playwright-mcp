import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { InstanceManager } from './instance-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolRouter } from './tool-router.js';
import { AuthManager } from './auth-manager.js';
import type { MultiplexerConfig } from './types.js';

export class MultiplexerServer {
  private server: Server;
  private instanceManager: InstanceManager;
  private toolRegistry: ToolRegistry;
  private toolRouter: ToolRouter;
  private authManager: AuthManager;

  constructor(config: MultiplexerConfig = {}) {
    this.instanceManager = new InstanceManager(config);
    this.toolRegistry = new ToolRegistry();
    this.authManager = new AuthManager(
      this.instanceManager.getConfig().authDir,
    );
    this.toolRouter = new ToolRouter(
      this.instanceManager,
      this.toolRegistry,
      this.authManager,
    );

    this.server = new Server(
      { name: 'playwright-mcp-multiplexer', version: '0.0.1' },
      { capabilities: { tools: {} } },
    );

    this.registerHandlers();
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.instanceManager.closeAll();
    await this.server.close();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Lazy discovery: on first call, spawn a probe instance to discover tools
      if (!this.toolRegistry.isInitialized()) {
        await this.discoverTools();
      }

      return { tools: this.toolRegistry.getTools() };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Ensure tools are discovered before routing
      if (!this.toolRegistry.isInitialized()) {
        // For management tools like instance_create, route first then discover
        if (this.toolRegistry.isManagementTool(name)) {
          const result = await this.toolRouter.route(name, args as Record<string, unknown> | undefined);
          // After instance_create, we now have an instance to discover from
          if (name === 'instance_create')
            await this.discoverTools();
          return result as unknown as Record<string, unknown>;
        }
        await this.discoverTools();
      }

      const result = await this.toolRouter.route(name, args as Record<string, unknown> | undefined);
      return result as unknown as Record<string, unknown>;
    });
  }

  private async discoverTools(): Promise<void> {
    // Try to use an existing instance for discovery
    const existing = this.instanceManager.list().find(i => i.status === 'ready');
    if (existing) {
      await this.toolRegistry.discoverTools(existing.client);
      return;
    }

    // Otherwise spawn a temporary probe instance
    const probe = await this.instanceManager.create({ headless: true });
    try {
      await this.toolRegistry.discoverTools(probe.client);
    } finally {
      await this.instanceManager.close(probe.id);
    }
  }
}
