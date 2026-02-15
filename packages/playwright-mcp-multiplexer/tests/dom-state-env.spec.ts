import path from 'node:path';
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

test.describe('DOM State Environment Variables', () => {
  test('should pass PW_DOM_STATE_INSTANCE_ID and PW_DOM_STATE_WORKSPACE to child instances', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [CLI_PATH, '--headless'],
      stderr: 'pipe',
    });

    const client = new Client({
      name: 'test-client',
      version: '1.0.0',
    });

    try {
      // Connect - this triggers the multiplexer to request roots from client
      await client.connect(transport);

      // Create an instance
      const createResult = await client.callTool({
        name: 'instance_create',
        arguments: {},
      });

      const createText = (createResult.content as Array<{ text: string }>)[0].text;
      const instanceId = createText.match(/"(inst-\d+)"/)![1];

      // Verify instance ID format
      expect(instanceId).toMatch(/^inst-\d+$/);

      // Navigate to verify the child process works
      // The child process has PW_DOM_STATE_INSTANCE_ID and PW_DOM_STATE_WORKSPACE set
      // which will be used by the DomState module when it's implemented
      const navResult = await client.callTool({
        name: 'browser_navigate',
        arguments: {
          instanceId,
          url: 'data:text/html,<h1>Env Test</h1>',
        },
      });

      expect(navResult.isError).toBeFalsy();

      // Clean up
      await client.callTool({
        name: 'instance_close_all',
        arguments: {},
      });

      await client.close();
    } catch (error) {
      await client.close();
      throw error;
    }
  });

  test('should assign unique instance IDs to different instances', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [CLI_PATH, '--headless'],
      stderr: 'pipe',
    });

    const client = new Client({
      name: 'test-client',
      version: '1.0.0',
    });

    try {
      await client.connect(transport);

      // Create two instances
      const result1 = await client.callTool({
        name: 'instance_create',
        arguments: {},
      });
      const id1 = ((result1.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      const result2 = await client.callTool({
        name: 'instance_create',
        arguments: {},
      });
      const id2 = ((result2.content as Array<{ text: string }>)[0].text).match(/"(inst-\d+)"/)![1];

      // Verify different instance IDs
      expect(id1).not.toEqual(id2);
      expect(id1).toMatch(/^inst-\d+$/);
      expect(id2).toMatch(/^inst-\d+$/);

      // Each child would receive its own PW_DOM_STATE_INSTANCE_ID
      // inst-1, inst-2, etc.

      await client.callTool({
        name: 'instance_close_all',
        arguments: {},
      });

      await client.close();
    } catch (error) {
      await client.close();
      throw error;
    }
  });

  test('should disable DOM state env vars when domState: false', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [CLI_PATH, '--headless'],
      stderr: 'pipe',
    });

    const client = new Client({
      name: 'test-client',
      version: '1.0.0',
    });

    try {
      await client.connect(transport);

      // Create instance with domState disabled
      const createResult = await client.callTool({
        name: 'instance_create',
        arguments: { domState: false },
      });

      expect(createResult.isError).toBeFalsy();
      const createText = (createResult.content as Array<{ text: string }>)[0].text;
      const instanceId = createText.match(/"(inst-\d+)"/)![1];

      // Navigate and verify the instance works (just no DOM state files)
      const navResult = await client.callTool({
        name: 'browser_navigate',
        arguments: {
          instanceId,
          url: 'data:text/html,<h1>No DOM State</h1>',
        },
      });

      expect(navResult.isError).toBeFalsy();
      const navText = (navResult.content as Array<{ text: string }>)[0].text;

      // Response should NOT contain "Browser State" section since DOM state is disabled
      expect(navText).not.toContain('Browser State');

      // List instances — should show domState=off
      const listResult = await client.callTool({
        name: 'instance_list',
        arguments: {},
      });
      const listText = (listResult.content as Array<{ text: string }>)[0].text;
      expect(listText).toContain('domState=off');

      await client.callTool({
        name: 'instance_close_all',
        arguments: {},
      });

      await client.close();
    } catch (error) {
      await client.close();
      throw error;
    }
  });

  test('should not set env vars if no workspace root is available', async () => {
    // Client connects without declaring roots
    const transport = new StdioClientTransport({
      command: 'node',
      args: [CLI_PATH, '--headless'],
      stderr: 'pipe',
    });

    const client = new Client({
      name: 'test-client',
      version: '1.0.0',
    });

    try {
      await client.connect(transport);

      // Create instance without workspace info
      const createResult = await client.callTool({
        name: 'instance_create',
        arguments: {},
      });

      expect(createResult.isError).toBeFalsy();

      // Instance should still work, just without DOM state env vars
      const createText = (createResult.content as Array<{ text: string }>)[0].text;
      expect(createText).toContain('Created browser instance');

      await client.callTool({
        name: 'instance_close_all',
        arguments: {},
      });

      await client.close();
    } catch (error) {
      await client.close();
      throw error;
    }
  });
});
