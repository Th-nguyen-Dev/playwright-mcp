import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MultiplexerConfig } from './types.js';
export declare class MultiplexerServer {
    private server;
    private instanceManager;
    private toolRegistry;
    private toolRouter;
    private authManager;
    constructor(config?: MultiplexerConfig);
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
    private registerHandlers;
    private discoverTools;
}
//# sourceMappingURL=multiplexer-server.d.ts.map