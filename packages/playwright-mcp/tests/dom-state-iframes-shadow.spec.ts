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

test.describe('iframe stitching', () => {
  test('same-origin iframe content is inlined with BEGIN/END markers', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    // Set up child frame content
    server.setContent('/child', '<body><input type="text" name="card" placeholder="Card number"></body>', 'text/html');

    // Set up parent page with iframe
    server.setContent('/parent', `
      <body>
        <h1>Payment</h1>
        <iframe src="${server.PREFIX}child" id="payment-frame"></iframe>
        <button>Pay</button>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'parent' },
    });

    // Read the dom.html file
    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // Verify iframe stitching markers are present
    expect(dom).toContain('<!-- BEGIN IFRAME');
    expect(dom).toContain('<!-- END IFRAME');

    // Verify child frame content is included
    expect(dom).toContain('Card number');

    // Verify parent content is also present
    expect(dom).toContain('Payment');
    expect(dom).toContain('Pay');
  });

  test('iframe refs appear in stitched output', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    server.setContent('/child', '<body><button>Submit</button></body>', 'text/html');
    server.setContent('/parent', `
      <body>
        <iframe src="${server.PREFIX}child"></iframe>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'parent' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // Check for iframe ref pattern (e.g., f1e1, f1e2)
    expect(dom).toMatch(/ref="f\d+e\d+"/);

    // Verify the iframe element has a ref attribute
    expect(dom).toMatch(/<iframe[^>]*ref="f\d+e\d+"/);
  });

  test('child frame elements have ref attributes', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    server.setContent('/child', `
      <body>
        <button>Click me</button>
        <input type="text" placeholder="Name">
      </body>
    `, 'text/html');

    server.setContent('/parent', `
      <body>
        <h1>Parent Page</h1>
        <iframe src="${server.PREFIX}child"></iframe>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'parent' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // Find the iframe section
    const iframeMatch = dom.match(/<!-- BEGIN IFRAME ([^>]+) -->([\s\S]*?)<!-- END IFRAME \1 -->/);
    expect(iframeMatch).toBeTruthy();

    if (iframeMatch) {
      const iframeContent = iframeMatch[2];

      // Verify elements within the iframe have ref attributes
      expect(iframeContent).toMatch(/ref="e\d+"/);

      // Verify the button and input are present
      expect(iframeContent).toContain('Click me');
      expect(iframeContent).toContain('Name');
    }
  });

  test('cross-origin iframe is gracefully skipped', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    // Child served from different origin (127.0.0.1 instead of localhost)
    server.setContent('/child', '<body><p>Cross-origin content</p></body>', 'text/html');

    server.setContent('/parent', `
      <body>
        <h1>Parent Page</h1>
        <iframe src="${server.CROSS_PROCESS_PREFIX}child" id="cross-origin-frame"></iframe>
        <button>Parent Button</button>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'parent' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // Parent content should still be present
    expect(dom).toContain('Parent Page');
    expect(dom).toContain('Parent Button');

    // Cross-origin iframe content should NOT be inlined
    expect(dom).not.toContain('Cross-origin content');

    // The iframe element itself should still be in the DOM
    expect(dom).toMatch(/<iframe[^>]*>/);
  });

  test('nested iframe (iframe within iframe)', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    // Innermost iframe
    server.setContent('/nested', '<body><p>Nested content</p></body>', 'text/html');

    // Middle iframe containing another iframe
    server.setContent('/child', `
      <body>
        <p>Child frame</p>
        <iframe src="${server.PREFIX}nested"></iframe>
      </body>
    `, 'text/html');

    // Parent page
    server.setContent('/parent', `
      <body>
        <h1>Parent</h1>
        <iframe src="${server.PREFIX}child"></iframe>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'parent' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // All three levels should be present
    expect(dom).toContain('Parent');
    expect(dom).toContain('Child frame');
    expect(dom).toContain('Nested content');

    // Should have multiple iframe markers
    const beginMarkers = dom.match(/<!-- BEGIN IFRAME/g);
    expect(beginMarkers).toBeTruthy();
    expect(beginMarkers!.length).toBeGreaterThanOrEqual(2);
  });

  test('detached iframe is handled gracefully', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    server.setContent('/child', '<body><p>Child content</p></body>', 'text/html');

    server.setContent('/parent', `
      <body>
        <h1>Parent</h1>
        <iframe src="${server.PREFIX}child" id="temp-frame"></iframe>
        <button>Click</button>
        <script>
          // Remove iframe after it loads
          setTimeout(() => {
            document.getElementById('temp-frame').remove();
          }, 100);
        </script>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'parent' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // Parent content should still be present
    expect(dom).toContain('Parent');
    expect(dom).toContain('Click');

    // DOM extraction should complete without errors (basic sanity check)
    expect(dom).toContain('<body>');
    expect(dom).toContain('</body>');
  });
});

test.describe('shadow DOM', () => {
  test('shadow DOM content is serialized with markers', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    server.setContent('/shadow', `
      <body>
        <h1>Main Content</h1>
        <my-widget></my-widget>
        <script>
          class MyWidget extends HTMLElement {
            constructor() {
              super();
              const shadow = this.attachShadow({ mode: 'open' });
              shadow.innerHTML = '<div class="inner"><button>Click me</button><span>Widget text</span></div>';
            }
          }
          customElements.define('my-widget', MyWidget);
        </script>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'shadow' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // Verify shadow root markers
    expect(dom).toContain('<!-- shadow-root -->');
    expect(dom).toContain('<!-- /shadow-root -->');

    // Verify shadow DOM content is serialized
    expect(dom).toContain('Click me');
    expect(dom).toContain('Widget text');

    // Verify main content is also present
    expect(dom).toContain('Main Content');
  });

  test('shadow DOM elements have ref attributes', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    server.setContent('/shadow', `
      <body>
        <my-component></my-component>
        <script>
          class MyComponent extends HTMLElement {
            constructor() {
              super();
              const shadow = this.attachShadow({ mode: 'open' });
              shadow.innerHTML = '<button>Shadow Button</button><input type="text" placeholder="Shadow Input">';
            }
          }
          customElements.define('my-component', MyComponent);
        </script>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'shadow' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // Find the shadow root section
    const shadowMatch = dom.match(/<!-- shadow-root -->([\s\S]*?)<!-- \/shadow-root -->/);
    expect(shadowMatch).toBeTruthy();

    if (shadowMatch) {
      const shadowContent = shadowMatch[1];

      // Verify elements within shadow DOM have ref attributes from _ariaRef
      expect(shadowContent).toMatch(/ref="e\d+"/);

      // Verify the button and input are present
      expect(shadowContent).toContain('Shadow Button');
      expect(shadowContent).toContain('Shadow Input');
    }
  });

  test('nested shadow DOM is traversed', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    server.setContent('/shadow', `
      <body>
        <outer-component></outer-component>
        <script>
          class InnerComponent extends HTMLElement {
            constructor() {
              super();
              const shadow = this.attachShadow({ mode: 'open' });
              shadow.innerHTML = '<p>Inner shadow content</p>';
            }
          }
          customElements.define('inner-component', InnerComponent);

          class OuterComponent extends HTMLElement {
            constructor() {
              super();
              const shadow = this.attachShadow({ mode: 'open' });
              shadow.innerHTML = '<div>Outer shadow</div><inner-component></inner-component>';
            }
          }
          customElements.define('outer-component', OuterComponent);
        </script>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'shadow' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // Should have multiple shadow-root markers
    const shadowMarkers = dom.match(/<!-- shadow-root -->/g);
    expect(shadowMarkers).toBeTruthy();
    expect(shadowMarkers!.length).toBeGreaterThanOrEqual(2);

    // Both levels of content should be present
    expect(dom).toContain('Outer shadow');
    expect(dom).toContain('Inner shadow content');
  });

  test('closed shadow DOM mode is handled', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    server.setContent('/shadow', `
      <body>
        <h1>Page</h1>
        <closed-widget></closed-widget>
        <script>
          class ClosedWidget extends HTMLElement {
            constructor() {
              super();
              // Note: closed mode shadow root
              const shadow = this.attachShadow({ mode: 'closed' });
              shadow.innerHTML = '<p>Closed shadow content</p>';
            }
          }
          customElements.define('closed-widget', ClosedWidget);
        </script>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'shadow' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // Page content should be present
    expect(dom).toContain('Page');

    // DOM extraction should complete without errors
    expect(dom).toContain('<body>');
    expect(dom).toContain('</body>');

    // Note: Closed shadow roots cannot be accessed via element.shadowRoot,
    // so they won't be serialized. This test just verifies graceful handling.
  });
});

test.describe('combined scenarios', () => {
  test('iframe containing shadow DOM component', async ({ startClient, server }) => {
    const workspaceDir = test.info().outputPath('workspace');
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const rootUri = `file://${workspaceDir}`;

    const { client } = await startClient({
      roots: [{ name: 'workspace', uri: rootUri }],
      config: {
        snapshot: { mode: 'incremental' },
      },
    });

    // Child frame with shadow DOM
    server.setContent('/child', `
      <body>
        <shadow-widget></shadow-widget>
        <script>
          class ShadowWidget extends HTMLElement {
            constructor() {
              super();
              const shadow = this.attachShadow({ mode: 'open' });
              shadow.innerHTML = '<button>Shadow in iframe</button>';
            }
          }
          customElements.define('shadow-widget', ShadowWidget);
        </script>
      </body>
    `, 'text/html');

    server.setContent('/parent', `
      <body>
        <h1>Parent</h1>
        <iframe src="${server.PREFIX}child"></iframe>
      </body>
    `, 'text/html');

    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX + 'parent' },
    });

    const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
    const dom = await fs.promises.readFile(path.join(stateDir, 'dom.html'), 'utf-8');

    // Should have both iframe and shadow markers
    expect(dom).toContain('<!-- BEGIN IFRAME');
    expect(dom).toContain('<!-- shadow-root -->');

    // Shadow content inside iframe should be present
    expect(dom).toContain('Shadow in iframe');
    expect(dom).toContain('Parent');
  });
});
