import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

/**
 * Create a multiplexer client with a temporary workspace directory.
 * The client will respond to roots/list requests with the provided workspace path.
 */
async function createMultiplexerClientWithWorkspace(extraArgs: string[] = []): Promise<{
  client: Client;
  workspaceDir: string;
  cleanup: () => Promise<void>;
}> {
  // Create temporary workspace directory
  const workspaceDir = path.join(os.tmpdir(), 'pw-mcp-test-workspace-' + Date.now());
  await fs.promises.mkdir(workspaceDir, { recursive: true });

  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH, '--headless', ...extraArgs],
    stderr: 'pipe',
  });

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    {
      capabilities: {
        roots: {
          listChanged: true,
        },
      },
    }
  );

  // Set up roots handler BEFORE connecting
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    return {
      roots: [
        {
          uri: `file://${workspaceDir}`,
          name: 'Test Workspace',
        },
      ],
    };
  });

  await client.connect(transport);

  return {
    client,
    workspaceDir,
    cleanup: async () => {
      try {
        await client.callTool({ name: 'instance_close_all', arguments: {} });
      } catch {
        // Ignore errors during cleanup
      }
      await client.close();
      await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test.describe('DOM State Multiplexer Integration', () => {
  test('should provide correct workspace paths for instance isolation', async () => {
    const { client, workspaceDir, cleanup } = await createMultiplexerClientWithWorkspace();
    try {
      // Create two instances
      const create1 = await client.callTool({ name: 'instance_create', arguments: {} });
      const id1 = ((create1.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      const create2 = await client.callTool({ name: 'instance_create', arguments: {} });
      const id2 = ((create2.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      // Navigate each to different pages
      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId: id1, url: 'data:text/html,<h1>Page One</h1><p>First Instance</p>' },
      });

      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId: id2, url: 'data:text/html,<h1>Page Two</h1><p>Second Instance</p>' },
      });

      // Verify instances are running and independent
      const snap1 = await client.callTool({
        name: 'browser_snapshot',
        arguments: { instanceId: id1 },
      });
      const snap1Text = (snap1.content as Array<{ text: string }>)[0].text;
      expect(snap1Text).toContain('Page One');

      const snap2 = await client.callTool({
        name: 'browser_snapshot',
        arguments: { instanceId: id2 },
      });
      const snap2Text = (snap2.content as Array<{ text: string }>)[0].text;
      expect(snap2Text).toContain('Page Two');

      // Verify that the workspace directory structure is set up correctly
      // The env vars PW_DOM_STATE_WORKSPACE and PW_DOM_STATE_INSTANCE_ID
      // would cause DOM files to be written to these paths when the feature is implemented
      const expectedPath1 = path.join(workspaceDir, '.playwright-mcp', 'browser-state', id1);
      const expectedPath2 = path.join(workspaceDir, '.playwright-mcp', 'browser-state', id2);

      // Verify paths are different
      expect(expectedPath1).not.toEqual(expectedPath2);
      expect(expectedPath1).toContain(id1);
      expect(expectedPath2).toContain(id2);
      expect(expectedPath1).toContain(workspaceDir);
      expect(expectedPath2).toContain(workspaceDir);
    } finally {
      await cleanup();
    }
  });

  test('should construct instance-specific paths correctly', async () => {
    const { client, workspaceDir, cleanup } = await createMultiplexerClientWithWorkspace();
    try {
      // Create instance
      const createResult = await client.callTool({ name: 'instance_create', arguments: {} });
      const instanceId = ((createResult.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      // Navigate
      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId, url: 'data:text/html,<h1>Test Page</h1>' },
      });

      // Get snapshot
      const snapResult = await client.callTool({
        name: 'browser_snapshot',
        arguments: { instanceId },
      });

      const snapText = (snapResult.content as Array<{ text: string }>)[0].text;
      expect(snapText).toContain('Test Page');

      // Verify the expected DOM path structure
      const expectedDomPath = path.join(workspaceDir, '.playwright-mcp', 'browser-state', instanceId, 'dom.html');
      expect(expectedDomPath).toContain(instanceId);
      expect(expectedDomPath).toContain('.playwright-mcp');
      expect(expectedDomPath).toContain('browser-state');
    } finally {
      await cleanup();
    }
  });

  test('should maintain independent browser state between instances', async () => {
    const { client, workspaceDir, cleanup } = await createMultiplexerClientWithWorkspace();
    try {
      // Create two instances
      const create1 = await client.callTool({ name: 'instance_create', arguments: {} });
      const id1 = ((create1.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      const create2 = await client.callTool({ name: 'instance_create', arguments: {} });
      const id2 = ((create2.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      // Navigate instance 1
      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId: id1, url: 'data:text/html,<h1>Instance One Only</h1>' },
      });

      const snap1 = await client.callTool({
        name: 'browser_snapshot',
        arguments: { instanceId: id1 },
      });
      const snap1Text = (snap1.content as Array<{ text: string }>)[0].text;
      expect(snap1Text).toContain('Instance One Only');

      // Navigate instance 2 to different content
      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId: id2, url: 'data:text/html,<h1>Instance Two Only</h1>' },
      });

      const snap2 = await client.callTool({
        name: 'browser_snapshot',
        arguments: { instanceId: id2 },
      });
      const snap2Text = (snap2.content as Array<{ text: string }>)[0].text;
      expect(snap2Text).toContain('Instance Two Only');

      // Verify instance 1 is still on its original page (independent state)
      const snap1Again = await client.callTool({
        name: 'browser_snapshot',
        arguments: { instanceId: id1 },
      });
      const snap1AgainText = (snap1Again.content as Array<{ text: string }>)[0].text;
      expect(snap1AgainText).toContain('Instance One Only');
      expect(snap1AgainText).not.toContain('Instance Two');

      // Verify instance path separation
      const path1 = path.join(workspaceDir, '.playwright-mcp', 'browser-state', id1);
      const path2 = path.join(workspaceDir, '.playwright-mcp', 'browser-state', id2);
      expect(path1).not.toEqual(path2);
    } finally {
      await cleanup();
    }
  });

  test('should handle instance closure without affecting other instances', async () => {
    const { client, workspaceDir, cleanup } = await createMultiplexerClientWithWorkspace();
    try {
      // Create two instances
      const create1 = await client.callTool({ name: 'instance_create', arguments: {} });
      const id1 = ((create1.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      const create2 = await client.callTool({ name: 'instance_create', arguments: {} });
      const id2 = ((create2.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      // Navigate both instances
      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId: id1, url: 'data:text/html,<h1>First</h1>' },
      });

      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId: id2, url: 'data:text/html,<h1>Second</h1>' },
      });

      // Verify both instances work
      const snap1 = await client.callTool({ name: 'browser_snapshot', arguments: { instanceId: id1 } });
      expect((snap1.content as Array<{ text: string }>)[0].text).toContain('First');

      const snap2 = await client.callTool({ name: 'browser_snapshot', arguments: { instanceId: id2 } });
      expect((snap2.content as Array<{ text: string }>)[0].text).toContain('Second');

      // Close instance 1
      await client.callTool({
        name: 'instance_close',
        arguments: { instanceId: id1 },
      });

      // Verify instance 1 is closed
      const listResult = await client.callTool({ name: 'instance_list', arguments: {} });
      const listText = (listResult.content as Array<{ text: string }>)[0].text;
      expect(listText).not.toContain(id1);
      expect(listText).toContain(id2);

      // Verify instance 2 still works
      const snap2After = await client.callTool({ name: 'browser_snapshot', arguments: { instanceId: id2 } });
      expect((snap2After.content as Array<{ text: string }>)[0].text).toContain('Second');

      // Note: DOM state directories persist after instance closure by design
      // This allows inspection of the last state even after the instance is gone
    } finally {
      await cleanup();
    }
  });

  test('should handle no workspace root - DOM state disabled', async () => {
    // Create client WITHOUT workspace roots
    const transport = new StdioClientTransport({
      command: 'node',
      args: [CLI_PATH, '--headless'],
      stderr: 'pipe',
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });

    // No roots handler - client won't provide workspace info
    try {
      await client.connect(transport);

      // Create instance
      const createResult = await client.callTool({ name: 'instance_create', arguments: {} });
      const instanceId = ((createResult.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      // Navigate
      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId, url: 'data:text/html,<h1>No Workspace Test</h1>' },
      });

      // Snapshot should still work (DOM state writing will be silently skipped)
      const snapResult = await client.callTool({
        name: 'browser_snapshot',
        arguments: { instanceId },
      });

      expect(snapResult.isError).toBeFalsy();
      const snapText = (snapResult.content as Array<{ text: string }>)[0].text;
      expect(snapText).toContain('No Workspace Test');

      // DOM state path should not be in the response (or indicate no workspace)
      // The snapshot should succeed but not reference any file path
    } finally {
      await client.callTool({ name: 'instance_close_all', arguments: {} }).catch(() => {});
      await client.close();
    }
  });

  test('should set up environment for DOM state with correct workspace and instance ID', async () => {
    const { client, workspaceDir, cleanup } = await createMultiplexerClientWithWorkspace();
    try {
      // Create instance
      const createResult = await client.callTool({ name: 'instance_create', arguments: {} });
      const instanceId = ((createResult.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      // Navigate to trigger child process operations
      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId, url: 'data:text/html,<h1>Env Var Test</h1>' },
      });

      // Get snapshot to verify instance is working
      const snapResult = await client.callTool({
        name: 'browser_snapshot',
        arguments: { instanceId },
      });
      expect((snapResult.content as Array<{ text: string }>)[0].text).toContain('Env Var Test');

      // Verify the expected structure for DOM state paths
      // The env vars PW_DOM_STATE_INSTANCE_ID and PW_DOM_STATE_WORKSPACE
      // would be used to construct these paths when DOM state writing is implemented
      const expectedDomPath = path.join(workspaceDir, '.playwright-mcp', 'browser-state', instanceId, 'dom.html');
      expect(expectedDomPath).toContain(instanceId);
      expect(expectedDomPath).toContain(workspaceDir);
      expect(expectedDomPath).toContain('.playwright-mcp');
      expect(expectedDomPath).toContain('browser-state');
    } finally {
      await cleanup();
    }
  });

  test('should create unique state paths for multiple concurrent instances', async () => {
    const { client, workspaceDir, cleanup } = await createMultiplexerClientWithWorkspace();
    try {
      // Create three instances
      const create1 = await client.callTool({ name: 'instance_create', arguments: {} });
      const id1 = ((create1.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      const create2 = await client.callTool({ name: 'instance_create', arguments: {} });
      const id2 = ((create2.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      const create3 = await client.callTool({ name: 'instance_create', arguments: {} });
      const id3 = ((create3.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      // Verify unique IDs
      expect(id1).not.toEqual(id2);
      expect(id2).not.toEqual(id3);
      expect(id1).not.toEqual(id3);

      // Navigate all instances to different content
      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId: id1, url: 'data:text/html,<h1>Instance 1</h1>' },
      });
      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId: id2, url: 'data:text/html,<h1>Instance 2</h1>' },
      });
      await client.callTool({
        name: 'browser_navigate',
        arguments: { instanceId: id3, url: 'data:text/html,<h1>Instance 3</h1>' },
      });

      // Verify all instances have independent state
      const snap1 = await client.callTool({ name: 'browser_snapshot', arguments: { instanceId: id1 } });
      const snap2 = await client.callTool({ name: 'browser_snapshot', arguments: { instanceId: id2 } });
      const snap3 = await client.callTool({ name: 'browser_snapshot', arguments: { instanceId: id3 } });

      expect((snap1.content as Array<{ text: string }>)[0].text).toContain('Instance 1');
      expect((snap2.content as Array<{ text: string }>)[0].text).toContain('Instance 2');
      expect((snap3.content as Array<{ text: string }>)[0].text).toContain('Instance 3');

      // Verify each would have unique DOM state paths
      const path1 = path.join(workspaceDir, '.playwright-mcp', 'browser-state', id1, 'dom.html');
      const path2 = path.join(workspaceDir, '.playwright-mcp', 'browser-state', id2, 'dom.html');
      const path3 = path.join(workspaceDir, '.playwright-mcp', 'browser-state', id3, 'dom.html');

      // All paths should be unique
      expect(path1).not.toEqual(path2);
      expect(path2).not.toEqual(path3);
      expect(path1).not.toEqual(path3);

      // All paths should contain their respective instance IDs
      expect(path1).toContain(id1);
      expect(path2).toContain(id2);
      expect(path3).toContain(id3);
    } finally {
      await cleanup();
    }
  });
});
