# TICKET-005: Create domState.ts -- Core DOM state orchestrator

## Metadata
| Field | Value |
|-------|-------|
| Status | COMPLETED |
| Priority | P0-Critical |
| Effort | L (4-8hr) |
| Assignee | Claude |

## Description
Create the `domState.ts` module -- the core Node.js orchestrator that ties together DOM extraction, pretty-printing, diffing, and file I/O. This module:

1. Resolves the workspace directory (multiplexer env vars or MCP roots)
2. Calls `extractFullDom(page)` which runs `AIDomBuilderInjection` in the main frame and stitches iframe content
3. Pretty-prints the HTML via `prettyPrintHtml()`
4. Computes a unified diff against the previous DOM using `diff.createPatch()` from `playwright-core/lib/utilsBundle`
5. Writes `dom.html`, `accessibility-tree.yaml`, and diff files to `.playwright-mcp/browser-state/`
6. Returns file paths and diff content for the response

The `DomState` class is instantiated once per `Context` and maintains state across tool calls (previous DOM, diff counter, state directory).

## Technical Approach
- **Architecture Layer**: Backend (Node.js orchestrator)
- **Design Patterns**: State machine, coordinator/facade
- **Implementation Strategy**:
  1. Create `domState.ts` in `playwright/packages/playwright/src/mcp/browser/`
  2. Implement the `DomState` class with `update()` and `dispose()` methods
  3. Implement `extractFullDom(page)` as a module-level async function
  4. Implement `formatDiffName()` as a module-level helper
  5. Export the `DomState` class and `DomStateResult` type

## Files Affected
- `playwright/packages/playwright/src/mcp/browser/domState.ts` - Create - Core orchestrator module

## Dependencies
- **Prerequisite Tickets**: TICKET-002 (domPrettyPrint.ts), TICKET-003 (domExtractor.ts)
- **External Dependencies**: `diff` from `playwright-core/lib/utilsBundle` (already bundled), `fs`, `path`
- **Potential Blockers**: The `diff` import path must match what playwright-core actually exports. Verify `diff.createPatch` is available.

## Acceptance Criteria
- [ ] `DomState` class is exported with `update()` and `dispose()` methods
- [ ] `update()` resolves workspace directory from env vars (`PW_DOM_STATE_INSTANCE_ID` + `PW_DOM_STATE_WORKSPACE`) or `context.hasExplicitRoots()` + `context.firstRootPath()`
- [ ] `update()` returns `undefined` and does no work when no workspace is available
- [ ] `update()` bails before `page.evaluate()` when no workspace is available (performance optimization)
- [ ] `update()` writes `dom.html` with pretty-printed HTML to the state directory
- [ ] `update()` writes `accessibility-tree.yaml` with the full aria snapshot
- [ ] `update()` writes diff files to `diffs/` subdirectory with sequential numbering
- [ ] Diff files are named `NNN-action-suffix.diff` (e.g., `001-navigate-example-com.diff`, `002-click-e14.diff`)
- [ ] First invocation produces no diff (no previous state)
- [ ] `createPatch()` output is checked for actual hunks (`@@`) before writing -- header-only patches are skipped
- [ ] `dispose()` deletes the entire `browser-state/` directory recursively
- [ ] `extractFullDom()` runs `AIDomBuilderInjection` in the main frame
- [ ] `extractFullDom()` stitches iframe content using `page.locator('aria-ref=REF').contentFrame()` + `frame.evaluate(AIDomBuilderInjection)`
- [ ] `extractFullDom()` handles iframe errors gracefully (frame navigated, detached, cross-origin)
- [ ] Nested iframes are supported (child frames with their own iframes)
- [ ] `formatDiffName()` sanitizes special characters and truncates values
- [ ] `DomStateResult` type is exported

## Testing Requirements
- **Unit Tests**:
  - Test `_ensureStateDir` with multiplexer env vars
  - Test `_ensureStateDir` with explicit roots
  - Test `_ensureStateDir` with neither (returns undefined)
  - Test `formatDiffName` with various tool names and args
  - Test diff detection (with changes vs without changes)
- **Integration Tests**:
  - Navigate to a page, verify `dom.html` and `accessibility-tree.yaml` on disk
  - Perform an action, verify diff file on disk
  - Perform 5 actions, verify 5 sequential diff files
  - Test with a page containing iframes
  - Test `dispose()` deletes the directory
- **Manual Testing**: Run through a complete form-filling flow, inspect all generated files
- **Coverage Target**: 85%

## Implementation Notes
The `extractFullDom()` function follows this pattern:

```typescript
async function extractFullDom(page: Page): Promise<string> {
  const main = await callOnPageNoTrace(page, p => p.evaluate(AIDomBuilderInjection));
  let html = main.html;

  for (const ref of main.iframeRefs) {
    try {
      const frame = page.locator(`aria-ref=${ref}`).contentFrame();
      const child = await frame.evaluate(AIDomBuilderInjection);
      html = html.replace(
        `<iframe ref="${ref}"></iframe>`,
        `<iframe ref="${ref}">\n<!-- BEGIN IFRAME ${ref} -->\n${child.html}\n<!-- END IFRAME ${ref} -->\n</iframe>`
      );
      // Recurse for nested iframes
      for (const childRef of child.iframeRefs) {
        const nestedFrame = frame.locator(`aria-ref=${childRef}`).contentFrame();
        const nested = await nestedFrame.evaluate(AIDomBuilderInjection);
        html = html.replace(
          `<iframe ref="${childRef}"></iframe>`,
          `<iframe ref="${childRef}">\n<!-- BEGIN IFRAME ${childRef} -->\n${nested.html}\n<!-- END IFRAME ${childRef} -->\n</iframe>`
        );
      }
    } catch {
      // Frame navigated, detached, or cross-origin
    }
  }
  return html;
}
```

The `diff` import from `playwright-core/lib/utilsBundle`:
```typescript
import { diff } from 'playwright-core/lib/utilsBundle';
const patch = diff.createPatch('dom.html', previousHtml, currentHtml, undefined, undefined, { context: 3 });
```

The `callOnPageNoTrace` utility from `tools/utils.ts` wraps `page.evaluate()` to suppress trace recording for internal operations.

Directory structure for multiplexer mode vs standalone:
- Multiplexer: `<workspace>/.playwright-mcp/browser-state/<instanceId>/`
- Standalone: `<rootPath>/.playwright-mcp/browser-state/`

## References
- Spec Section: 8.3 (domState.ts full implementation)
- Spec Section: 8.3 (Iframe Stitching)
- Spec Section: 8.3 (File Path Resolution)
- Related Tickets: TICKET-002, TICKET-003 (dependencies), TICKET-004 (Context owns DomState), TICKET-006 (Response calls DomState)
