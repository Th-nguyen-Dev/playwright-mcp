/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from './fixtures';
import fs from 'fs';
import path from 'path';

test.describe('DOM State Integration Tests', () => {
  test('browser_navigate creates Browser State section in response', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', '<body><h1>Hello World</h1></body>', 'text/html');

    const response = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const text = (response.content as any)[0].text;
    expect(text).toContain('### Browser State');
    expect(text).toContain('dom.html');
    expect(text).toContain('accessibility-tree.yaml');
  });

  test('browser_navigate creates dom.html on disk with refs', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', '<body><h1>Hello World</h1><input type="text" name="query"></body>', 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const domPath = path.join(stateDir, 'dom.html');

    const dom = await fs.promises.readFile(domPath, 'utf-8');

    expect(dom).toContain('<h1');
    expect(dom).toContain('<input');
    expect(dom).toMatch(/ref="e\d+"/);
  });

  test('browser_navigate creates accessibility-tree.yaml on disk', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', '<body><h1>Hello World</h1></body>', 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const ariaPath = path.join(stateDir, 'accessibility-tree.yaml');

    const aria = await fs.promises.readFile(ariaPath, 'utf-8');

    expect(aria).toBeTruthy();
    expect(aria).toMatch(/\[ref=e\d+\]/);
  });

  test('browser_navigate does not create diff file on first navigation', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', '<body><h1>Hello</h1></body>', 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const diffsDir = path.join(stateDir, 'diffs');

    const diffExists = await fs.promises.access(diffsDir)
      .then(() => true)
      .catch(() => false);

    expect(diffExists).toBe(false);
  });

  test('browser_click creates diff file showing state change', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', `
      <body>
        <button id="testBtn">Click Me</button>
        <script>
          document.getElementById('testBtn').addEventListener('click', () => {
            document.getElementById('testBtn').focus();
          });
        </script>
      </body>
    `, 'text/html');

    const navResponse = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const navText = (navResponse.content as any)[0].text;
    const refMatch = navText.match(/button.*\[ref=(e\d+)\]/);
    expect(refMatch).toBeTruthy();
    const buttonRef = refMatch![1];

    await client.callTool({
      name: 'browser_click',
      arguments: {
        element: 'Click Me button',
        ref: buttonRef,
      },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const diffsDir = path.join(stateDir, 'diffs');
    const diffFiles = await fs.promises.readdir(diffsDir);

    expect(diffFiles.length).toBeGreaterThan(0);
    expect(diffFiles[0]).toMatch(/^\d{3}-/);

    const diffContent = await fs.promises.readFile(path.join(diffsDir, diffFiles[0]), 'utf-8');
    expect(diffContent).toContain('button');
  });

  test('browser_type creates diff file showing value change', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', `
      <body>
        <input type="text" id="search" name="q" placeholder="Search...">
      </body>
    `, 'text/html');

    const navResponse = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const navText = (navResponse.content as any)[0].text;
    const refMatch = navText.match(/textbox.*\[ref=(e\d+)\]/);
    expect(refMatch).toBeTruthy();
    const inputRef = refMatch![1];

    await client.callTool({
      name: 'browser_type',
      arguments: {
        element: 'search textbox',
        ref: inputRef,
        text: 'test query',
      },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const diffsDir = path.join(stateDir, 'diffs');
    const diffFiles = await fs.promises.readdir(diffsDir);

    expect(diffFiles.length).toBeGreaterThan(0);

    const diffContent = await fs.promises.readFile(path.join(diffsDir, diffFiles[0]), 'utf-8');
    expect(diffContent).toContain('value');
    expect(diffContent).toContain('test query');
  });

  test('refs cross-reference between dom.html and accessibility-tree.yaml', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', `
      <body>
        <label for="email">Email:</label>
        <input type="email" id="email" name="email">
        <button>Submit</button>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const domPath = path.join(stateDir, 'dom.html');
    const ariaPath = path.join(stateDir, 'accessibility-tree.yaml');

    const dom = await fs.promises.readFile(domPath, 'utf-8');
    const aria = await fs.promises.readFile(ariaPath, 'utf-8');

    const domRefs = [...dom.matchAll(/ref="(e\d+)"/g)].map(m => m[1]);
    const ariaRefs = [...aria.matchAll(/\[ref=(e\d+)\]/g)].map(m => m[1]);

    expect(domRefs.length).toBeGreaterThan(0);
    expect(ariaRefs.length).toBeGreaterThan(0);

    for (const ariaRef of ariaRefs) {
      expect(domRefs).toContain(ariaRef);
    }
  });

  test('sequential actions produce numbered diff files', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', `
      <body>
        <input type="text" id="input1">
        <input type="text" id="input2">
        <input type="text" id="input3">
        <button id="btn1">Button 1</button>
        <button id="btn2">Button 2</button>
      </body>
    `, 'text/html');

    const navResponse = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const navText = (navResponse.content as any)[0].text;

    const input1Match = navText.match(/input1.*\[ref=(e\d+)\]/);
    const input2Match = navText.match(/input2.*\[ref=(e\d+)\]/);
    const input3Match = navText.match(/input3.*\[ref=(e\d+)\]/);
    const btn1Match = navText.match(/Button 1.*\[ref=(e\d+)\]/);
    const btn2Match = navText.match(/Button 2.*\[ref=(e\d+)\]/);

    expect(input1Match).toBeTruthy();
    expect(input2Match).toBeTruthy();
    expect(input3Match).toBeTruthy();
    expect(btn1Match).toBeTruthy();
    expect(btn2Match).toBeTruthy();

    await client.callTool({
      name: 'browser_type',
      arguments: { element: 'input1', ref: input1Match![1], text: 'first' },
    });

    await client.callTool({
      name: 'browser_type',
      arguments: { element: 'input2', ref: input2Match![1], text: 'second' },
    });

    await client.callTool({
      name: 'browser_type',
      arguments: { element: 'input3', ref: input3Match![1], text: 'third' },
    });

    await client.callTool({
      name: 'browser_click',
      arguments: { element: 'Button 1', ref: btn1Match![1] },
    });

    await client.callTool({
      name: 'browser_click',
      arguments: { element: 'Button 2', ref: btn2Match![1] },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const diffsDir = path.join(stateDir, 'diffs');
    const diffFiles = await fs.promises.readdir(diffsDir);

    diffFiles.sort();

    expect(diffFiles.length).toBe(5);
    expect(diffFiles[0]).toMatch(/^001-/);
    expect(diffFiles[1]).toMatch(/^002-/);
    expect(diffFiles[2]).toMatch(/^003-/);
    expect(diffFiles[3]).toMatch(/^004-/);
    expect(diffFiles[4]).toMatch(/^005-/);
  });

  test('dom.html strips scripts, styles, handlers, and data attributes', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', `
      <head>
        <style>.test { color: red; }</style>
        <script>console.log('hello');</script>
      </head>
      <body>
        <div onclick="alert('test')" data-test-id="123" style="color: blue;">
          Content
        </div>
        <script src="app.js"></script>
        <noscript>JavaScript disabled</noscript>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const domPath = path.join(stateDir, 'dom.html');

    const dom = await fs.promises.readFile(domPath, 'utf-8');

    expect(dom).not.toContain('<script');
    expect(dom).not.toContain('<style');
    expect(dom).not.toContain('onclick');
    expect(dom).not.toContain('data-test-id');
    expect(dom).not.toContain('style=');
    expect(dom).not.toContain('<noscript');
    expect(dom).toContain('Content');
  });

  test('client without roots does not create Browser State section or files', async ({ startClient, server }) => {
    const { client } = await startClient();

    server.setContent('/test', '<body><h1>Hello</h1></body>', 'text/html');

    const response = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const text = (response.content as any)[0].text;

    expect(text).not.toContain('### Browser State');
    expect(text).not.toContain('dom.html');
    expect(text).not.toContain('accessibility-tree.yaml');
  });

  test('MCP server shutdown deletes browser-state directory', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', '<body><h1>Hello</h1></body>', 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');

    const existsBeforeClose = await fs.promises.access(stateDir)
      .then(() => true)
      .catch(() => false);

    expect(existsBeforeClose).toBe(true);

    await client.close();

    await new Promise(resolve => setTimeout(resolve, 500));

    const existsAfterClose = await fs.promises.access(stateDir)
      .then(() => true)
      .catch(() => false);

    expect(existsAfterClose).toBe(false);
  });

  test('browser_fill_form creates diff file showing multiple value changes', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', `
      <body>
        <form>
          <input type="text" name="username" id="username">
          <input type="email" name="email" id="email">
          <input type="password" name="password" id="password">
          <button type="submit">Submit</button>
        </form>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    await client.callTool({
      name: 'browser_fill_form',
      arguments: {
        fields: [
          { name: 'username', value: 'testuser' },
          { name: 'email', value: 'test@example.com' },
          { name: 'password', value: 'secret123' },
        ],
      },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const diffsDir = path.join(stateDir, 'diffs');
    const diffFiles = await fs.promises.readdir(diffsDir);

    expect(diffFiles.length).toBeGreaterThan(0);

    const diffContent = await fs.promises.readFile(path.join(diffsDir, diffFiles[0]), 'utf-8');
    expect(diffContent).toContain('username');
    expect(diffContent).toContain('email');
    expect(diffContent).toContain('testuser');
    expect(diffContent).toContain('test@example.com');
  });

  test('grep can find refs in dom.html with useful context', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
    });

    server.setContent('/test', `
      <body>
        <label for="email">Email Address:</label>
        <input type="email" id="email" name="email" placeholder="Enter your email">
        <span class="help-text">We'll never share your email</span>
      </body>
    `, 'text/html');

    const navResponse = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'test' },
    });

    const navText = (navResponse.content as any)[0].text;
    const refMatch = navText.match(/textbox.*\[ref=(e\d+)\]/);
    expect(refMatch).toBeTruthy();
    const inputRef = refMatch![1];

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const domPath = path.join(stateDir, 'dom.html');

    const dom = await fs.promises.readFile(domPath, 'utf-8');

    const refPattern = new RegExp(`ref="${inputRef}"`, 'g');
    const refLine = dom.split('\n').find(line => refPattern.test(line));

    expect(refLine).toBeTruthy();
    expect(refLine).toContain('email');
  });
});
