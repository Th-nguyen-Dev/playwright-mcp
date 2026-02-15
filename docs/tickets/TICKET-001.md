# TICKET-001: Add js-beautify dependency to Playwright package

## Metadata
| Field | Value |
|-------|-------|
| Status | COMPLETED |
| Priority | P0-Critical |
| Effort | S (< 1hr) |
| Assignee | Unassigned |

## Description
Add `js-beautify` as a production dependency to the forked Playwright package. This library provides deterministic HTML formatting with `force-aligned` attribute wrapping, which is essential for producing clean, single-line diffs when element attribute values change (e.g., a `value=""` becoming `value="John"` after a form fill).

This is a prerequisite for all DOM state functionality. Without it, the pretty-printer module (`domPrettyPrint.ts`) cannot be implemented.

## Technical Approach
- **Architecture Layer**: Infrastructure
- **Design Patterns**: N/A (dependency management only)
- **Implementation Strategy**:
  1. Run `npm install js-beautify` in the `playwright/packages/playwright/` directory
  2. Verify the dependency appears in `package.json` under `dependencies`
  3. Verify `js-beautify` can be imported from TypeScript (types are bundled or available via `@types/js-beautify`)
  4. Run the Playwright build to confirm no compilation issues

## Files Affected
- `playwright/packages/playwright/package.json` - Modify - Add `"js-beautify": "^1.15.0"` to dependencies

## Dependencies
- **Prerequisite Tickets**: None
- **External Dependencies**: `js-beautify` npm package (^1.15.0)
- **Potential Blockers**: Type definitions may need `@types/js-beautify` if not bundled

## Acceptance Criteria
- [ ] `js-beautify` is listed in `playwright/packages/playwright/package.json` under `dependencies`
- [ ] `import { html_beautify } from 'js-beautify'` compiles without errors
- [ ] `node utils/build/build.js` in the playwright root completes successfully
- [ ] No version conflicts with existing playwright-core dependencies

## Testing Requirements
- **Unit Tests**: None needed (dependency installation only)
- **Integration Tests**: Build verification via `node utils/build/build.js`
- **Manual Testing**: Import `html_beautify` in a scratch file and format a simple HTML string
- **Coverage Target**: N/A

## Implementation Notes
`js-beautify` is used server-side only (Node.js, not browser context). It will be imported by `domPrettyPrint.ts` which runs in the Node.js orchestrator, never inside `page.evaluate()`.

If `@types/js-beautify` is needed separately, install it as a devDependency. The package has 50M+ weekly npm downloads and is actively maintained.

## References
- Spec Section: 8.2 (New Dependency)
- Related Tickets: TICKET-002 (domPrettyPrint.ts depends on this)
- External Docs: https://github.com/beautifier/js-beautify
