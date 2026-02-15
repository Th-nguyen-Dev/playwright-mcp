# TICKET-003: Create domExtractor.ts -- AIDomBuilder browser-side DOM serializer

## Metadata
| Field | Value |
|-------|-------|
| Status | COMPLETED |
| Priority | P0-Critical |
| Effort | L (4-8hr) |
| Assignee | Claude |

## Description
Create the `domExtractor.ts` module containing `AIDomBuilderInjection` -- a self-contained function that runs inside the browser via `page.evaluate()`. It walks the DOM tree starting from `document.body`, strips noise (scripts, styles, event handlers, data-attributes, generated CSS classes), stamps `ref` attributes from `_ariaRef` properties (set by Playwright's `captureSnapshot()`), serializes to an HTML string, crosses shadow DOM boundaries, and collects iframe refs for stitching.

This is the most complex single module in the feature. Everything -- the class, all constants, all helper functions -- MUST be defined inside the function body because `page.evaluate()` serializes the function as a string and cannot reference external scope.

## Technical Approach
- **Architecture Layer**: Backend (browser-injected code)
- **Design Patterns**: Visitor/tree walker pattern (mirrors Playwright's `generateAriaTree`)
- **Implementation Strategy**:
  1. Create `domExtractor.ts` in `playwright/packages/playwright/src/mcp/browser/`
  2. Export `AIDomBuilderInjection` as a named export
  3. All code (constants, helpers, `AIDomBuilder` class) lives inside the function body
  4. The function returns `{ html: string, iframeRefs: string[] }`
  5. Follow the exact structure from the spec section 8.3

## Files Affected
- `playwright/packages/playwright/src/mcp/browser/domExtractor.ts` - Create - Self-contained DOM serializer function

## Dependencies
- **Prerequisite Tickets**: None (no external dependencies)
- **External Dependencies**: None (runs in browser context, must be self-contained)
- **Potential Blockers**: Must not import anything -- `page.evaluate()` serialization constraint

## Acceptance Criteria
- [ ] `AIDomBuilderInjection` is exported as a named export
- [ ] Function returns `{ html: string, iframeRefs: string[] }`
- [ ] `<script>`, `<style>`, `<noscript>`, `<template>` elements are skipped entirely
- [ ] `<link rel="stylesheet">` elements are skipped
- [ ] Event handler attributes (`onclick`, `onchange`, etc.) are stripped
- [ ] `style` attributes are stripped
- [ ] `data-*` attributes are stripped
- [ ] Existing `ref` attributes on elements are skipped (Vue collision prevention)
- [ ] `_ariaRef.ref` from DOM elements is stamped as `ref="eN"` attribute (always last)
- [ ] CSS classes are filtered: generated classes (`css-*`, `sc-*`, `emotion-*`, `styled-*`, `jsx-*`, CSS modules hashes, long hex hashes) are stripped; semantic classes (`help-text`, `error-message`) are kept
- [ ] If all class tokens are generated, the `class` attribute is omitted entirely
- [ ] Attributes are sorted in canonical order: `id` -> `type` -> `name` -> `role` -> `aria-*` -> `href`/`src`/`action`/`method`/`for` -> `value`/`placeholder`/`required`/`disabled`/`checked`/`selected` -> `class` -> (other) -> `ref` (always last)
- [ ] Void elements (`INPUT`, `BR`, `IMG`, etc.) produce self-closing tags with no children
- [ ] Shadow DOM roots are traversed with `<!-- shadow-root -->` / `<!-- /shadow-root -->` comment markers
- [ ] Iframe elements with `_ariaRef` have their refs collected in `iframeRefs`
- [ ] SVG `d` and `points` attributes on `PATH`/`POLYGON` elements are replaced with `"..."`
- [ ] Text content is escaped (`&`, `<`, `>`)
- [ ] Attribute values are escaped (`&`, `"`, `<`, `>`)
- [ ] Hidden elements (`display:none`, `aria-hidden="true"`) are kept (not stripped)
- [ ] The function is completely self-contained -- no imports, no closures over external scope
- [ ] The function compiles and can be passed to `page.evaluate()`

## Testing Requirements
- **Unit Tests**:
  - Test basic element serialization (tag + text content)
  - Test attribute stripping (style, data-*, event handlers)
  - Test `_ariaRef` stamping (mock `_ariaRef` on elements)
  - Test CSS class filtering (generated vs semantic classes)
  - Test all-generated-classes -> no class attribute
  - Test canonical attribute ordering
  - Test void element handling (no children, no closing tag)
  - Test `<script>`, `<style>`, `<noscript>` skipping
  - Test SVG noise attribute replacement
  - Test HTML/attribute escaping
  - Test hidden element preservation
  - Test iframe ref collection
  - Test shadow DOM traversal
- **Integration Tests**: Run `page.evaluate(AIDomBuilderInjection)` on a real page, verify output structure
- **Manual Testing**: Run against a complex page (e.g., a form with many fields) and inspect output
- **Coverage Target**: 90%+ for the builder logic

## Implementation Notes
The function follows the exact pattern from the spec. Key structure:

```typescript
export const AIDomBuilderInjection = (): { html: string, iframeRefs: string[] } => {
  // Constants: SKIP_TAGS, VOID_TAGS, SVG_NOISE_ATTRS, ATTR_ORDER, GENERATED_CLASS_PATTERNS
  // Helpers: shouldSkipAttribute, attrOrder, filterClasses, escapeHtml, escapeAttr
  // Class: AIDomBuilder with methods:
  //   build(root) -> { html, iframeRefs }
  //   _serializeElement(el)
  //   _serializeChildren(parent)
  //   _shouldSkipElement(el)
  //   _serializeAttributes(el)
  //   _serializeRef(el)
  //   _isSvgNoise(el, attrName)
  return new AIDomBuilder().build(document.body);
};
```

Critical: The `_ariaRef` property is a plain JS property on DOM elements, NOT an HTML attribute. It is set by Playwright's `computeAriaRef()` during `captureSnapshot()`. The builder reads `(el as any)._ariaRef?.ref` and writes it as a string attribute into the output HTML. This never modifies the live DOM.

The `filterClasses()` function uses regex patterns to detect generated class names. The patterns in the spec cover the major CSS-in-JS frameworks. The function splits the class string on whitespace, filters each token, and joins the remaining tokens.

## References
- Spec Section: 8.3 (domExtractor.ts)
- Spec Section: 3.1-3.4 (How Aria Refs Work)
- Related Tickets: TICKET-005 (domState.ts calls this via page.evaluate)
