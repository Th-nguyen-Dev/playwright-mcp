# TICKET-002: Create domPrettyPrint.ts -- HTML pretty-printer wrapper

## Metadata
| Field | Value |
|-------|-------|
| Status | COMPLETED |
| Priority | P0-Critical |
| Effort | S (< 1hr) |
| Assignee | Claude Agent |

## Description
Create the `domPrettyPrint.ts` module that wraps `js-beautify`'s `html_beautify` function with a fixed configuration optimized for diff-friendly output. The key behavior is `force-aligned` attribute wrapping: when an element has 3+ attributes, each attribute gets its own line aligned under the first attribute. This produces minimal, single-line diffs when only one attribute value changes (e.g., `value=""` -> `value="John"`).

## Technical Approach
- **Architecture Layer**: Backend (Node.js utility module)
- **Design Patterns**: Configuration object, thin wrapper
- **Implementation Strategy**:
  1. Create `domPrettyPrint.ts` in `playwright/packages/playwright/src/mcp/browser/`
  2. Define `BEAUTIFY_OPTIONS` constant with the exact configuration from the spec
  3. Export `prettyPrintHtml(html: string): string` function
  4. The function simply calls `html_beautify(html, BEAUTIFY_OPTIONS)` and returns the result

## Files Affected
- `playwright/packages/playwright/src/mcp/browser/domPrettyPrint.ts` - Create - Pretty-printer module with `prettyPrintHtml` export

## Dependencies
- **Prerequisite Tickets**: TICKET-001 (js-beautify dependency)
- **External Dependencies**: `js-beautify` npm package
- **Potential Blockers**: None

## Acceptance Criteria
- [ ] `prettyPrintHtml()` is exported as a named export from `domPrettyPrint.ts`
- [ ] Elements with 1-2 attributes stay on one line: `<a href="/home" ref="e5">Home</a>`
- [ ] Elements with 3+ attributes get one attribute per line, aligned under the first:
  ```html
  <input id="first-name"
         type="text"
         name="firstName"
         required
         ref="e14">
  ```
- [ ] Output uses 2-space indentation for nesting
- [ ] `<pre>`, `<code>`, `<textarea>` content is not reformatted
- [ ] Void elements (`<input>`, `<br>`, `<img>`) do not get closing tags
- [ ] Output is deterministic -- same input always produces same output (no preserved original formatting)
- [ ] Output ends with a newline

## Testing Requirements
- **Unit Tests**:
  - Test simple element stays on one line
  - Test multi-attribute element wraps correctly
  - Test nested structure indentation
  - Test void elements (no closing tag)
  - Test pre/code content preservation
  - Test deterministic output (run twice, compare)
- **Integration Tests**: N/A (pure function, tested in isolation)
- **Manual Testing**: Format a sample AIDomBuilder output string and inspect visually
- **Coverage Target**: 100% (single function)

## Implementation Notes
The exact configuration from the spec:

```typescript
import { html_beautify } from 'js-beautify';

const BEAUTIFY_OPTIONS = {
  indent_size: 2,
  indent_char: ' ',
  wrap_line_length: 120,
  wrap_attributes: 'force-aligned' as const,
  wrap_attributes_min_attrs: 3,
  preserve_newlines: false,
  max_preserve_newlines: 0,
  end_with_newline: true,
  indent_inner_html: true,
  unformatted: ['code', 'pre'],
  content_unformatted: ['pre', 'code', 'textarea'],
  void_elements: [
    'area', 'base', 'br', 'col', 'embed', 'hr',
    'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'
  ],
};

export function prettyPrintHtml(html: string): string {
  return html_beautify(html, BEAUTIFY_OPTIONS);
}
```

`preserve_newlines: false` and `max_preserve_newlines: 0` are critical -- they ensure deterministic output regardless of the input formatting from `AIDomBuilder`.

## References
- Spec Section: 8.3 (domPrettyPrint.ts)
- Related Tickets: TICKET-001 (dependency), TICKET-005 (domState.ts consumes this)
- External Docs: https://github.com/beautifier/js-beautify#css--html
