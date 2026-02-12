const MANAGEMENT_TOOLS = [
    {
        name: 'instance_create',
        description: 'Create a new browser instance. Returns the instance ID for use with other tools.',
        inputSchema: {
            type: 'object',
            properties: {
                headless: { type: 'boolean', description: 'Run browser in headless mode (default: true)' },
                browser: { type: 'string', enum: ['chrome', 'chromium', 'firefox', 'webkit'], description: 'Browser type (default: from server config)' },
                storageState: { type: 'string', description: 'Path to a storageState JSON file for pre-authenticated sessions' },
                userDataDir: { type: 'string', description: 'Path to a Chrome user data directory to copy auth state from (overrides default)' },
            },
        },
    },
    {
        name: 'instance_list',
        description: 'List all active browser instances with their IDs and status.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'instance_close',
        description: 'Close a specific browser instance and release its resources.',
        inputSchema: {
            type: 'object',
            properties: {
                instanceId: { type: 'string', description: 'The instance ID to close' },
            },
            required: ['instanceId'],
        },
    },
    {
        name: 'instance_close_all',
        description: 'Close all browser instances and release all resources.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'auth_export_state',
        description: 'Export cookies and localStorage from a browser instance to a JSON file for sharing with other instances.',
        inputSchema: {
            type: 'object',
            properties: {
                instanceId: { type: 'string', description: 'The instance ID to export auth state from' },
                savePath: { type: 'string', description: 'Optional file path to save the state (defaults to auth directory)' },
            },
            required: ['instanceId'],
        },
    },
];
const MANAGEMENT_TOOL_NAMES = new Set(MANAGEMENT_TOOLS.map(t => t.name));
export class ToolRegistry {
    proxyTools = [];
    allTools = [];
    initialized = false;
    isManagementTool(name) {
        return MANAGEMENT_TOOL_NAMES.has(name);
    }
    isInitialized() {
        return this.initialized;
    }
    async discoverTools(probeClient) {
        const result = await probeClient.listTools();
        const childTools = result.tools;
        this.proxyTools = childTools.map(tool => this.augmentWithInstanceId(tool));
        this.allTools = [...MANAGEMENT_TOOLS, ...this.proxyTools];
        this.initialized = true;
    }
    getTools() {
        return this.allTools;
    }
    getManagementTools() {
        return MANAGEMENT_TOOLS;
    }
    isProxyTool(name) {
        return this.proxyTools.some(t => t.name === name);
    }
    augmentWithInstanceId(tool) {
        const schema = JSON.parse(JSON.stringify(tool.inputSchema));
        if (!schema.properties)
            schema.properties = {};
        schema.properties['instanceId'] = {
            type: 'string',
            description: 'Target browser instance ID (from instance_create or instance_list)',
        };
        if (!schema.required)
            schema.required = [];
        schema.required.unshift('instanceId');
        return {
            ...tool,
            inputSchema: schema,
        };
    }
}
//# sourceMappingURL=tool-registry.js.map