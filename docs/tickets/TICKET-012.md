# TICKET-012: Integration tests -- end-to-end tool call to file on disk

## Metadata
| Field | Value |
|-------|-------|
| Status | COMPLETED |
| Priority | P1-High |
| Effort | L (4-8hr) |
| Assignee | Claude |

## Description
Write end-to-end integration tests that exercise the complete DOM state pipeline through the MCP protocol: start an MCP server with a connected client (with roots declared), call browser tools, and verify that the correct files are written to disk with the expected content. These tests cover the full flow from `callTool` through `Response._build()` to files on disk.

The tests should use the existing test fixtures (`startClient` with `roots` option) and the test HTTP server to serve known HTML pages.

## Technical Approach
- **Architecture Layer**: Testing (integration)
- **Design Patterns**: End-to-end testing via MCP protocol
- **Implementation Strategy**:
  1. Create test file `tests/dom-state-integration.spec.ts` in the playwright-mcp test directory
  2. Use `startClient({ roots: [...] })` to connect a client with workspace roots declared
  3. Serve test HTML pages via the test server
  4. Call browser tools and verify both the response text and the files on disk
  5. Use `fs.readFileSync` to verify file contents match expectations

## Files Affected
- `playwright-mcp/packages/playwright-mcp/tests/dom-state-integration.spec.ts` - Create - End-to-end integration tests

## Dependencies
- **Prerequisite Tickets**: TICKET-008 (build must pass)
- **External Dependencies**: `@playwright/test`, test server, MCP test fixtures
- **Potential Blockers**: Test fixture must support passing `roots` (it already does via `startClient`)

## Acceptance Criteria
- [x] Test: `browser_navigate` -> response contains Browser State section with file paths
- [x] Test: `browser_navigate` -> `dom.html` exists on disk with refs matching aria tree
- [x] Test: `browser_navigate` -> `accessibility-tree.yaml` exists on disk
- [x] Test: `browser_navigate` -> no diff file on first navigation
- [x] Test: `browser_click` on a field -> diff file exists showing focus/active state change
- [x] Test: `browser_type` into a field -> diff file shows `value` attribute change
- [x] Test: `browser_fill_form` -> diff file shows multiple value changes
- [x] Test: Ref cross-reference: `ref="e14"` in `dom.html` matches `[ref=e14]` in `accessibility-tree.yaml`
- [x] Test: Grep cross-reference: grep for a ref in `dom.html` returns useful context (label, input, help text)
- [x] Test: 5 sequential actions produce 5 numbered diff files in order
- [x] Test: No `<script>`, `<style>`, inline handlers, or `data-*` attrs in `dom.html`
- [x] Test: Client without roots -> no Browser State section, no files on disk
- [x] Test: MCP server shutdown -> `.playwright-mcp/browser-state/` directory deleted
- [x] All tests pass with `npx playwright test dom-state-integration`

## Testing Requirements
- **Unit Tests**: N/A (this is integration testing)
- **Integration Tests**: This IS the integration test ticket
- **Manual Testing**: N/A
- **Coverage Target**: Exercises all code paths in domState.ts, domExtractor.ts, domPrettyPrint.ts, response.ts changes

## Implementation Notes
Test fixture setup with roots:

```typescript
test('navigate creates dom.html and aria tree', async ({ startClient, server }) => {
  const workspaceDir = test.info().outputPath('workspace');
  await fs.promises.mkdir(workspaceDir, { recursive: true });
  const rootUri = `file://${workspaceDir}`;

  const { client } = await startClient({
    roots: [{ name: 'workspace', uri: rootUri }],
  });

  server.setContent('/test', '<body><h1>Hello</h1><input type="text" name="q"></body>');

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/test' },
  });

  // Verify response contains Browser State section
  const text = response.content[0].text;
  expect(text).toContain('### Browser State');
  expect(text).toContain('dom.html');

  // Verify files on disk
  const domPath = path.join(workspaceDir, '.playwright-mcp', 'browser-state', 'dom.html');
  const dom = await fs.promises.readFile(domPath, 'utf-8');
  expect(dom).toContain('<h1');
  expect(dom).toContain('<input');
  expect(dom).not.toContain('<script');

  const ariaPath = path.join(workspaceDir, '.playwright-mcp', 'browser-state', 'accessibility-tree.yaml');
  expect(await fs.promises.access(ariaPath).then(() => true)).toBe(true);
});
```

For the cleanup test, close the client (which triggers MCP server shutdown and `Context.dispose()`) and verify the `browser-state/` directory is deleted.

For the "no roots" test, start a client without declaring roots and verify no Browser State section appears and no files are written.

## References
- Spec Section: 9 (What the AI Sees)
- Spec Section: 13, Test Cases 1-9, 17, 18 (end-to-end scenarios)
- Related Tickets: TICKET-009, TICKET-010, TICKET-011 (unit tests), TICKET-013 (performance tests)
