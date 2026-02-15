import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type InstanceStatus = 'starting' | 'ready' | 'closed';

export interface ManagedInstance {
  id: string;
  client: Client;
  transport: StdioClientTransport;
  config: InstanceConfig;
  createdAt: number;
  status: InstanceStatus;
}

export interface InstanceConfig {
  headless?: boolean;
  browser?: string;
  storageState?: string;
  userDataDir?: string;
  args?: string[];
  domState?: boolean;
}

export interface MultiplexerConfig {
  maxInstances?: number;
  defaultHeadless?: boolean;
  defaultBrowser?: string;
  authDir?: string;
  cliPath?: string;
  userDataDir?: string;
  profileName?: string;
}

export interface AugmentedTool extends Tool {
  // Tool with instanceId injected into its inputSchema
}

export interface ToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolCallResponse {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}
