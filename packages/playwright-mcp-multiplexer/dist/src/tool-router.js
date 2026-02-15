export class ToolRouter {
    instanceManager;
    toolRegistry;
    authManager;
    constructor(instanceManager, toolRegistry, authManager) {
        this.instanceManager = instanceManager;
        this.toolRegistry = toolRegistry;
        this.authManager = authManager;
    }
    async route(name, args = {}) {
        if (this.toolRegistry.isManagementTool(name))
            return this.handleManagementTool(name, args);
        if (this.toolRegistry.isProxyTool(name))
            return this.handleProxyTool(name, args);
        return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
        };
    }
    async handleManagementTool(name, args) {
        switch (name) {
            case 'instance_create':
                return this.handleInstanceCreate(args);
            case 'instance_list':
                return this.handleInstanceList();
            case 'instance_close':
                return this.handleInstanceClose(args);
            case 'instance_close_all':
                return this.handleInstanceCloseAll();
            case 'auth_export_state':
                return this.handleAuthExport(args);
            default:
                return {
                    content: [{ type: 'text', text: `Unknown management tool: ${name}` }],
                    isError: true,
                };
        }
    }
    async handleProxyTool(name, args) {
        const instanceId = args.instanceId;
        if (!instanceId) {
            return {
                content: [{ type: 'text', text: 'Missing required parameter: instanceId' }],
                isError: true,
            };
        }
        const instance = this.instanceManager.getOrThrow(instanceId);
        // Strip instanceId before forwarding to child
        const { instanceId: _, ...childArgs } = args;
        const result = await instance.client.callTool({
            name,
            arguments: childArgs,
        });
        return result;
    }
    async handleInstanceCreate(args) {
        try {
            const instance = await this.instanceManager.create({
                headless: args.headless,
                browser: args.browser,
                storageState: args.storageState,
                userDataDir: args.userDataDir,
                domState: args.domState,
            });
            const effectiveConfig = this.instanceManager.getConfig();
            const browser = instance.config.browser ?? effectiveConfig.defaultBrowser;
            const headless = instance.config.headless ?? effectiveConfig.defaultHeadless;
            return {
                content: [{
                        type: 'text',
                        text: `Created browser instance "${instance.id}" (${browser}, ${headless ? 'headless' : 'headed'})`,
                    }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Failed to create instance: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    }
    async handleInstanceList() {
        const instances = this.instanceManager.list();
        if (instances.length === 0) {
            return {
                content: [{ type: 'text', text: 'No active instances. Use instance_create to create one.' }],
            };
        }
        const effectiveConfig = this.instanceManager.getConfig();
        const lines = instances.map(inst => {
            const age = Math.round((Date.now() - inst.createdAt) / 1000);
            const browser = inst.config.browser ?? effectiveConfig.defaultBrowser;
            const headless = inst.config.headless ?? effectiveConfig.defaultHeadless;
            const domState = inst.config.domState !== false ? 'on' : 'off';
            return `- ${inst.id}: status=${inst.status}, browser=${browser}, ${headless ? 'headless' : 'headed'}, domState=${domState}, age=${age}s`;
        });
        return {
            content: [{ type: 'text', text: `Active instances (${instances.length}):\n${lines.join('\n')}` }],
        };
    }
    async handleInstanceClose(args) {
        const instanceId = args.instanceId;
        if (!instanceId) {
            return {
                content: [{ type: 'text', text: 'Missing required parameter: instanceId' }],
                isError: true,
            };
        }
        try {
            await this.instanceManager.close(instanceId);
            return {
                content: [{ type: 'text', text: `Closed instance "${instanceId}"` }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Failed to close instance: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    }
    async handleInstanceCloseAll() {
        const count = this.instanceManager.list().length;
        await this.instanceManager.closeAll();
        return {
            content: [{ type: 'text', text: `Closed ${count} instance(s)` }],
        };
    }
    async handleAuthExport(args) {
        const instanceId = args.instanceId;
        if (!instanceId) {
            return {
                content: [{ type: 'text', text: 'Missing required parameter: instanceId' }],
                isError: true,
            };
        }
        try {
            const instance = this.instanceManager.getOrThrow(instanceId);
            const savePath = args.savePath;
            const resultPath = await this.authManager.exportState(instance, savePath);
            return {
                content: [{ type: 'text', text: `Exported auth state from "${instanceId}" to: ${resultPath}` }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Failed to export auth state: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    }
}
//# sourceMappingURL=tool-router.js.map