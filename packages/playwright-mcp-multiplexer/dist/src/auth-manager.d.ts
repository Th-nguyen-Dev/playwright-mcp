import type { ManagedInstance } from './types.js';
export declare class AuthManager {
    private authDir;
    constructor(authDir: string);
    exportState(instance: ManagedInstance, savePath?: string): Promise<string>;
    private generateOutputPath;
}
//# sourceMappingURL=auth-manager.d.ts.map