You have a Playwright MCP multiplexer connected. I need you to run an A/B comparison.

Create two browser instances:
- Instance A: `instance_create { domState: false }` — no DOM state files
- Instance B: `instance_create { domState: true }` — DOM state enabled

For each of these 7 pages, navigate on BOTH instances and fill out the form with plausible data until you see a green success message:

1. `file:///home/electron/projects/explorer-workspace/playwright-mcp/docs/evaluations/test-pages/01-simple-form.html`
2. `file:///home/electron/projects/explorer-workspace/playwright-mcp/docs/evaluations/test-pages/02-ambiguous-form.html`
3. `file:///home/electron/projects/explorer-workspace/playwright-mcp/docs/evaluations/test-pages/03-validation-errors.html`
4. `file:///home/electron/projects/explorer-workspace/playwright-mcp/docs/evaluations/test-pages/04-wizard-form.html`
5. `file:///home/electron/projects/explorer-workspace/playwright-mcp/docs/evaluations/test-pages/05-large-dropdown.html`
6. `file:///home/electron/projects/explorer-workspace/playwright-mcp/docs/evaluations/test-pages/06-dynamic-form.html`
7. `file:///home/electron/projects/explorer-workspace/playwright-mcp/docs/evaluations/test-pages/07-nested-fieldsets.html`

When working on Instance B, you'll see a "Browser State" section in tool responses with file paths to DOM and accessibility tree files. Use the Read tool to read those files — they help you understand the page structure.

When working on Instance A, there are no such files. Just work from the snapshots.

After all 7 pages are done on both instances, tell me how many tool calls each instance took per page and whether DOM state helped.
