import type { InstanceManager } from './instance-manager.js';
import type { ToolRegistry } from './tool-registry.js';
import type { AuthManager } from './auth-manager.js';
import type { ToolCallResponse } from './types.js';
export declare class ToolRouter {
    private instanceManager;
    private toolRegistry;
    private authManager;
    constructor(instanceManager: InstanceManager, toolRegistry: ToolRegistry, authManager: AuthManager);
    route(name: string, args?: Record<string, unknown>): Promise<ToolCallResponse>;
    private handleManagementTool;
    private handleProxyTool;
    private handleInstanceCreate;
    private handleInstanceList;
    private handleInstanceClose;
    private handleInstanceCloseAll;
    private handleAuthExport;
}
//# sourceMappingURL=tool-router.d.ts.map