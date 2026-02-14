# TICKET-014: Integration tests -- iframe stitching and shadow DOM

## Metadata
| Field | Value |
|-------|-------|
| Status | COMPLETED |
| Priority | P1-High |
| Effort | M (1-4hr) |
| Assignee | Claude |

## Description
Write integration tests specifically for iframe stitching and shadow DOM traversal. These are complex DOM features that require real browser contexts to test properly. The tests verify that:

1. Iframe content is inlined into the parent DOM with `<!-- BEGIN IFRAME -->` / `<!-- END IFRAME -->` markers
2. Iframe element refs (e.g., `f1e1`) are correctly used for stitching
3. Nested iframes (iframe within iframe) are handled
4. Cross-origin iframes are handled gracefully (skipped without errors)
5. Shadow DOM components produce `<!-- shadow-root -->` / `<!-- /shadow-root -->` markers
6. Elements inside shadow DOM have their refs stamped correctly

## Technical Approach
- **Architecture Layer**: Testing (integration)
- **Design Patterns**: Multi-page test setup, web component registration
- **Implementation Strategy**:
  1. Create test file `tests/dom-state-iframes-shadow.spec.ts`
  2. For iframe tests: serve parent and child pages from the test server, use `<iframe src="...">` in the parent
  3. For shadow DOM tests: define custom elements with shadow roots in test page scripts
  4. Navigate via MCP tools, then read `dom.html` and verify structure

## Files Affected
- `playwright-mcp/packages/playwright-mcp/tests/dom-state-iframes-shadow.spec.ts` - Create - Iframe and shadow DOM tests

## Dependencies
- **Prerequisite Tickets**: TICKET-008 (build must pass)
- **External Dependencies**: `@playwright/test`, test server
- **Potential Blockers**: Cross-origin iframe tests may require test server configuration

## Acceptance Criteria
- [ ] Test: page with same-origin iframe -> child frame content inlined with BEGIN/END markers
- [ ] Test: iframe refs (e.g., `f1e1`) appear in the stitched output
- [ ] Test: child frame elements have their own ref attributes stamped
- [ ] Test: nested iframe (iframe within iframe) -> both levels stitched
- [ ] Test: cross-origin iframe -> gracefully skipped, parent DOM still complete
- [ ] Test: detached iframe (removed before extraction) -> gracefully handled
- [ ] Test: page with web component using shadow DOM -> shadow root children serialized
- [ ] Test: shadow DOM elements have refs stamped from `_ariaRef`
- [ ] Test: `<!-- shadow-root -->` and `<!-- /shadow-root -->` comment markers present
- [ ] Test: nested shadow DOM (shadow root containing another web component with shadow root) -> both levels traversed
- [ ] All tests pass

## Testing Requirements
- **Unit Tests**: N/A (these are integration tests)
- **Integration Tests**: This IS the integration test ticket for iframes and shadow DOM
- **Manual Testing**: N/A
- **Coverage Target**: Covers iframe and shadow DOM code paths in domExtractor.ts and domState.ts

## Implementation Notes
Iframe test setup:

```typescript
test('iframes are stitched into parent DOM', async ({ startClient, server }) => {
  server.setContent('/child', '<body><input type="text" name="card" placeholder="Card number"></body>');
  server.setContent('/parent', `
    <body>
      <h1>Payment</h1>
      <iframe src="${server.PREFIX}/child" id="payment-frame"></iframe>
      <button>Pay</button>
    </body>
  `);

  const { client } = await startClient({ roots: [...] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/parent' } });

  // Read dom.html
  const dom = await fs.promises.readFile(domPath, 'utf-8');
  expect(dom).toContain('<!-- BEGIN IFRAME');
  expect(dom).toContain('Card number');
  expect(dom).toContain('<!-- END IFRAME');
});
```

Shadow DOM test setup:

```typescript
test('shadow DOM content is serialized', async ({ startClient, server }) => {
  server.setContent('/shadow', `
    <body>
      <my-widget></my-widget>
      <script>
        class MyWidget extends HTMLElement {
          constructor() {
            super();
            const shadow = this.attachShadow({ mode: 'open' });
            shadow.innerHTML = '<div class="inner"><button>Click me</button></div>';
          }
        }
        customElements.define('my-widget', MyWidget);
      </script>
    </body>
  `);

  // Navigate and verify dom.html contains shadow-root markers and button
});
```

Note: The test must wait for custom elements to be defined before triggering the snapshot. The `browser_navigate` tool's `waitForCompletion` should handle this since it waits for network and DOM settlement.

## References
- Spec Section: 8.3 (Iframe Stitching), 12 Q4 (Shadow DOM), 12 Q5 (Iframe content)
- Spec Section: 13, Test Cases 11, 12, 16 (iframe and shadow DOM tests)
- Related Tickets: TICKET-003 (extractor implementation), TICKET-005 (stitching in domState)
