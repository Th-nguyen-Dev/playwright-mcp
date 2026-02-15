# TICKET-006: Integrate DOM state into Response._build() and add Browser State section

## Metadata
| Field | Value |
|-------|-------|
| Status | COMPLETED |
| Priority | P0-Critical |
| Effort | M (1-4hr) |
| Assignee | Claude |

## Description
Modify `response.ts` to integrate the DOM state system into the response pipeline. After the Snapshot section is built (which means `captureSnapshot()` has already run and populated `_ariaRef` on all DOM elements), call `domState.update()` and append a "Browser State" section with file paths to `dom.html`, `accessibility-tree.yaml`, and the diff file.

Also update `parseResponse()` to recognize the new "Browser State" section, which is needed by test fixtures.

## Technical Approach
- **Architecture Layer**: Backend (response pipeline)
- **Design Patterns**: Builder pattern (existing), hook point injection
- **Implementation Strategy**:
  1. Add `private _domState: DomState | undefined` field to `Response`
  2. Add `setDomState(domState: DomState)` method
  3. In `_build()`, after the Snapshot section and before the Events section, add DOM state section
  4. The section calls `this._domState.update(page, context, toolName, toolArgs, ariaSnapshot)`
  5. If `update()` returns a result, add "Browser State" section with relative file paths
  6. Update `parseResponse()` to extract the new section

## Files Affected
- `playwright/packages/playwright/src/mcp/browser/response.ts` - Modify - Add DomState integration and Browser State section

## Dependencies
- **Prerequisite Tickets**: TICKET-005 (domState.ts must exist)
- **External Dependencies**: None
- **Potential Blockers**: The `_build()` method must remain `async` (it already is). The DOM state section must be placed after the Snapshot section to ensure `captureSnapshot()` has run.

## Acceptance Criteria
- [ ] `Response` has a `setDomState(domState: DomState)` method
- [ ] When `_domState` is set and a snapshot is included, `_build()` calls `domState.update()`
- [ ] When `domState.update()` returns a result, a "Browser State" section is appended
- [ ] The Browser State section contains relative file paths using `_computRelativeTo()`
- [ ] The section format is:
  ```
  ### Browser State
  - DOM: .playwright-mcp/browser-state/dom.html
  - Accessibility tree: .playwright-mcp/browser-state/accessibility-tree.yaml
  - Diff: .playwright-mcp/browser-state/diffs/001-navigate.diff
  ```
- [ ] The Diff line is only present when a diff was generated (not on first navigation)
- [ ] When `_domState` is not set (e.g., not passed), no Browser State section appears
- [ ] When `_includeSnapshot` is `'none'`, DOM state is not extracted
- [ ] The full aria snapshot YAML is always passed to `domState.update()` (not the incremental diff)
- [ ] `parseResponse()` returns a `browserState` field containing the Browser State section text
- [ ] No changes to the existing response structure -- all other sections remain identical
- [ ] The Browser State section appears after the Snapshot section and before the Events section

## Testing Requirements
- **Unit Tests**:
  - Test `_build()` without domState set -> no Browser State section
  - Test `_build()` with domState set and snapshot included -> Browser State section present
  - Test `_build()` with `_includeSnapshot === 'none'` -> no Browser State section
  - Test `parseResponse()` extracts Browser State
- **Integration Tests**: Call a tool (e.g., `browser_navigate`), verify response text contains Browser State section with valid file paths
- **Manual Testing**: Navigate to a page, inspect the full tool response text
- **Coverage Target**: 80%

## Implementation Notes
The new section in `_build()` goes between the existing Snapshot section (lines 201-209) and the Events section (lines 212-229). The exact placement:

```typescript
// After the existing Snapshot section...

// DOM State section
if (this._domState && tabSnapshot && this._includeSnapshot !== 'none') {
  const result = await this._domState.update(
    this._context.currentTabOrDie().page,
    this._context,
    this.toolName,
    this.toolArgs,
    tabSnapshot.ariaSnapshot,  // always the full tree, not the diff
  );

  if (result) {
    const lines: string[] = [];
    lines.push(`- DOM: ${this._computRelativeTo(result.domPath)}`);
    lines.push(`- Accessibility tree: ${this._computRelativeTo(result.ariaPath)}`);
    if (result.diffPath)
      lines.push(`- Diff: ${this._computRelativeTo(result.diffPath)}`);
    addSection('Browser State', lines);
  }
}

// Events section (existing)...
```

Note that `tabSnapshot.ariaSnapshot` is always the full aria tree, while `tabSnapshot.ariaSnapshotDiff` is the incremental one. We always write the full tree to the file (the AI reads the file when it needs full context), but the in-context snapshot in the response can be incremental.

The `setDomState` method pattern matches the existing `setIncludeSnapshot` / `setIncludeFullSnapshot` pattern on `Response`.

For `parseResponse()`, add to the return object:
```typescript
const browserState = sections.get('Browser State');
// ... in return:
browserState,
```

## References
- Spec Section: 8.4 (response.ts modifications)
- Spec Section: 9 (What the AI Sees)
- Related Tickets: TICKET-004 (browserServerBackend passes DomState), TICKET-005 (DomState class)
