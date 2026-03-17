"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiplexerServer = void 0;
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const instance_manager_js_1 = require("./instance-manager.js");
const tool_registry_js_1 = require("./tool-registry.js");
const tool_router_js_1 = require("./tool-router.js");
const auth_manager_js_1 = require("./auth-manager.js");
class MultiplexerServer {
    server;
    instanceManager;
    toolRegistry;
    toolRouter;
    authManager;
    discoveryPromise = null;
    constructor(config = {}) {
        this.instanceManager = new instance_manager_js_1.InstanceManager(config);
        this.toolRegistry = new tool_registry_js_1.ToolRegistry();
        this.authManager = new auth_manager_js_1.AuthManager(this.instanceManager.getConfig().authDir);
        this.toolRouter = new tool_router_js_1.ToolRouter(this.instanceManager, this.toolRegistry, this.authManager);
        this.server = new index_js_1.Server({ name: 'playwright-mcp-multiplexer', version: '0.0.1' }, { capabilities: { tools: {} } });
        this.registerHandlers();
    }
    async connect(transport) {
        // Wait for the MCP handshake to complete before making server->client requests.
        // Server.connect() sets up I/O but the handshake (initialize/InitializeResult/initialized)
        // happens asynchronously. listRoots() will fail if called before the handshake.
        const handshakeComplete = new Promise(resolve => {
            this.server.setNotificationHandler(types_js_1.InitializedNotificationSchema, () => resolve());
        });
        await this.server.connect(transport);
        await handshakeComplete;
        // Now safe to make server->client requests
        try {
            const rootsResult = await this.server.listRoots();
            if (rootsResult.roots?.length > 0) {
                const firstRoot = rootsResult.roots[0];
                if (firstRoot.uri) {
                    // Convert file:// URI to path
                    const workspaceRoot = this.uriToPath(firstRoot.uri);
                    this.instanceManager.setWorkspaceRoot(workspaceRoot);
                }
            }
        }
        catch {
            // Client may not support roots - that's okay, DOM state will be disabled
        }
    }
    uriToPath(uri) {
        if (uri.startsWith('file://')) {
            // Remove file:// prefix and decode URI components
            let path = uri.slice(7);
            // On Windows, file:///C:/... becomes C:/...
            // On Unix, file:///home/... becomes /home/...
            if (process.platform === 'win32' && path.startsWith('/')) {
                path = path.slice(1);
            }
            return decodeURIComponent(path);
        }
        return uri;
    }
    async close() {
        await this.instanceManager.closeAll();
        await this.server.close();
    }
    registerHandlers() {
        this.server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
            // Lazy discovery: on first call, spawn a probe instance to discover tools
            if (!this.toolRegistry.isInitialized()) {
                await this.ensureToolsDiscovered();
            }
            return { tools: this.toolRegistry.getTools() };
        });
        this.server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            // Ensure tools are discovered before routing
            if (!this.toolRegistry.isInitialized()) {
                // For management tools like instance_create, route first then discover
                if (this.toolRegistry.isManagementTool(name)) {
                    const result = await this.toolRouter.route(name, args);
                    // After instance_create, we now have an instance to discover from
                    if (name === 'instance_create')
                        await this.ensureToolsDiscovered();
                    return result;
                }
                await this.ensureToolsDiscovered();
            }
            const result = await this.toolRouter.route(name, args);
            return result;
        });
    }
    async ensureToolsDiscovered() {
        if (this.toolRegistry.isInitialized())
            return;
        if (!this.discoveryPromise) {
            this.discoveryPromise = this.discoverTools().catch(err => {
                // Allow retry on failure by resetting the cached promise
                this.discoveryPromise = null;
                throw err;
            });
        }
        return this.discoveryPromise;
    }
    async discoverTools() {
        // Try to use an existing instance for discovery
        const existing = this.instanceManager.list().find(i => i.status === 'ready');
        if (existing) {
            await this.toolRegistry.discoverTools(existing.client);
            return;
        }
        // Spawn a minimal probe for tool discovery. In Electron mode the probe
        // connects via CDP (inherited from server config) — no need to override
        // userDataDir since CDP mode skips profile management entirely.
        // In normal mode, userDataDir: null forces --isolated (no profile copy).
        const probeConfig = this.instanceManager.getConfig().electronMode
            ? { headless: true, extension: false, domState: false }
            : { headless: true, userDataDir: null, extension: false };
        const probe = await this.instanceManager.create(probeConfig);
        try {
            await this.toolRegistry.discoverTools(probe.client);
        }
        finally {
            await this.instanceManager.close(probe.id);
        }
    }
}
exports.MultiplexerServer = MultiplexerServer;
//# sourceMappingURL=multiplexer-server.js.map