import type { ManagedInstance, InstanceConfig, MultiplexerConfig } from './types.js';
export declare class InstanceManager {
    private instances;
    private profileDirs;
    private configFiles;
    private nextId;
    private config;
    constructor(config?: MultiplexerConfig);
    private resolveDefaultCliPath;
    create(instanceConfig?: InstanceConfig): Promise<ManagedInstance>;
    get(id: string): ManagedInstance | undefined;
    getOrThrow(id: string): ManagedInstance;
    list(): ManagedInstance[];
    close(id: string): Promise<void>;
    closeAll(): Promise<void>;
    getConfig(): Readonly<Required<MultiplexerConfig>>;
    private buildArgs;
    private createLaunchConfig;
    private copyProfile;
    private cleanupProfile;
}
//# sourceMappingURL=instance-manager.d.ts.map