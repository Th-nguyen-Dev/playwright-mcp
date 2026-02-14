# AI Agent Guide: Using Playwright MCP

This guide is for AI agents using the Playwright MCP server to automate web browsers. It explains how to effectively use the browser automation tools and DOM state files.

## DOM State Files

After every browser action that includes a snapshot, the MCP server writes DOM state files to `.playwright-mcp/browser-state/`:

- **`dom.html`** - Full page DOM, stripped of noise (scripts, styles, analytics attributes), with `ref="eN"` attributes matching the aria tree
- **`accessibility-tree.yaml`** - The aria snapshot (same as in-context responses)
- **`diffs/NNN-action.diff`** - What changed after each action (unified diff format)

### When to Use DOM Files

**Primary navigation tool:** Use the aria tree (provided in-context in tool responses) as your primary navigation map. It tells you element roles, names, and refs in a compact format.

**Use DOM files when you need MORE context:**

1. **Confused about a field?** Grep for its ref in `dom.html` to see surrounding labels, help text, error messages, form structure
2. **Debugging validation errors?** Read the diff to see exactly what changed (new error messages, aria-invalid attributes)
3. **Need to understand page structure?** Read the full DOM or specific sections
4. **Looking for specific text or elements?** Grep the DOM for field names, labels, or ref values
5. **Checking dropdown options?** All option elements are present in `dom.html` even if not in the compact aria tree
6. **Tracking action history?** Review diff files to see the sequence of changes

### Cross-Referencing Refs

The `ref="eN"` attributes in `dom.html` match exactly with the `[ref=eN]` markers in the aria tree. This allows you to:

- See an element in the aria tree (e.g., `textbox "Email" [ref=e18]`)
- Grep for that ref in `dom.html` to see full context: labels, help text, validation errors, surrounding structure

**Example aria tree:**
```yaml
- textbox "Email" [ref=e18]: ""
```

**Corresponding DOM (via Grep):**
```html
<label for="email">Email <span>*</span></label>
<input id="email"
       type="email"
       name="email"
       required
       aria-required="true"
       aria-describedby="email-help"
       value=""
       ref="e18">
<span id="email-help" class="help-text">We'll use this to contact you about your application</span>
```

## Usage Examples

### Example 1: Grep for a ref to see surrounding context

When you see `textbox "First Name" [ref=e14]` in the aria tree but want to understand the field better:

```
Grep "ref=\"e14\"" .playwright-mcp/browser-state/dom.html -C 5
```

This shows 5 lines before and after the element, revealing labels, help text, validation messages, and form structure.

### Example 2: Read the diff after an action to verify changes

After filling a form field, read the diff to confirm the value changed:

```
Read .playwright-mcp/browser-state/diffs/003-fill-form.diff
```

Example diff output:
```diff
@@ -15,7 +15,7 @@
         type="text"
         name="firstName"
         required
         aria-required="true"
-        value=""
+        value="John"
         ref="e14">
```

You see exactly one line changed - the value attribute.

### Example 3: Read the full DOM when the aria tree is insufficient

When the aria tree is too compact and you need full page context:

```
Read .playwright-mcp/browser-state/dom.html
```

For large pages, use offset/limit to read specific sections:
```
Read .playwright-mcp/browser-state/dom.html --offset 100 --limit 50
```

### Example 4: Grep for specific text to find fields

Looking for a "confirm password" field:
```
Grep "confirm" .playwright-mcp/browser-state/dom.html -i -C 3
```

The `-i` flag makes it case-insensitive, and `-C 3` shows 3 lines of context.

### Example 5: Check validation errors in a diff

After submitting a form, check what error messages appeared:

```
Read .playwright-mcp/browser-state/diffs/007-click-submit.diff
```

Example diff showing validation error:
```diff
@@ -22,9 +22,11 @@
         type="email"
         name="email"
         required
         aria-required="true"
+        aria-invalid="true"
         aria-describedby="email-help"
-        value=""
+        value="not-an-email"
         ref="e18">
-        <span id="email-help" class="help-text">We'll use this to contact you</span>
+        <span id="email-help" class="help-text">We'll use this to contact you</span>
+        <span class="error-message" role="alert">Please enter a valid email address</span>
```

You see: the value changed, `aria-invalid="true"` was added, and an error message span appeared.

### Example 6: Grep for all help text on the page

To see all help text hints:
```
Grep "help-text" .playwright-mcp/browser-state/dom.html
```

This returns all elements with the `help-text` class.

## Multiplexer: Per-Instance Files

When using the `playwright-mcp-multiplexer` package (managing multiple browser instances), DOM state files are organized per-instance:

```
.playwright-mcp/browser-state/
  inst-1/
    dom.html
    accessibility-tree.yaml
    diffs/
  inst-2/
    dom.html
    accessibility-tree.yaml
    diffs/
```

Tool responses include the instance ID in file paths:

```
### Browser State
- DOM: .playwright-mcp/browser-state/inst-1/dom.html
- Accessibility tree: .playwright-mcp/browser-state/inst-1/accessibility-tree.yaml
- Diff: .playwright-mcp/browser-state/inst-1/diffs/002-click-e14.diff
```

Use the correct instance path when reading files:
```
Read .playwright-mcp/browser-state/inst-1/dom.html
Grep "ref=\"e18\"" .playwright-mcp/browser-state/inst-2/dom.html -C 5
```

## What Gets Stripped from DOM

The DOM file is cleaned to remove noise while preserving semantic information:

**Removed:**
- `<head>` entirely (meta tags, stylesheets, title)
- `<script>` elements
- `<style>` elements
- Inline `style` attributes
- `data-*` attributes (analytics, test IDs, framework internals)
- Event handlers (`onclick`, `onchange`, etc.)
- Generated CSS class names (`css-a1b2c3`, `sc-dkPtRN`)

**Kept:**
- All semantic HTML structure
- `id`, `name`, `for`, `type`, `required`, `placeholder`, `value`
- `aria-*` attributes
- `role` attribute
- `href`, `action`, `method`
- Semantic CSS classes (`help-text`, `error-message`, `required`)
- Text content (labels, help text, error messages, headings)
- `ref` attribute (injected to match aria tree)

## DOM File Format

The DOM is pretty-printed with one attribute per line for elements with 3+ attributes. This ensures clean diffs - when a value changes, only that one line appears in the diff:

**Simple elements (1-2 attributes):**
```html
<a href="/home" ref="e5">Home</a>
<button ref="e8">Sign Out</button>
```

**Complex elements (3+ attributes):**
```html
<input id="first-name"
       type="text"
       name="firstName"
       required
       aria-required="true"
       value=""
       ref="e14">
```

Attributes are in canonical order: `id` → `type` → `name` → `role` → `aria-*` → `href` → `value` → `class` → `ref` (always last).

## Diff Trail

Diffs accumulate during your session, creating an action history:

```
diffs/
  001-navigate-workday-com-apply.diff
  002-click-e14.diff
  003-type-e14-John.diff
  004-click-e18.diff
  005-type-e18-john-example-com.diff
  006-select-option-e22-United-States.diff
  007-fill-form.diff
```

The counter ensures ordering. The action description comes from the tool name plus key arguments (ref, value).

You can read any previous diff to see what that action changed:
```
Read .playwright-mcp/browser-state/diffs/002-click-e14.diff
```

## Best Practices

1. **Start with the aria tree** (in-context) - it's compact and sufficient for most navigation
2. **Grep for refs** when you need context around a specific element
3. **Read diffs** after form fills or interactions to verify expected changes
4. **Read full DOM** only when you need comprehensive page understanding
5. **Use case-insensitive Grep** (`-i`) when searching for text that might vary in capitalization
6. **Check diff files** when debugging - they show exactly what changed without re-reading the entire page

## Common Patterns

### Pattern: Fill a form field with validation

1. See field in aria tree: `textbox "Email" [ref=e18]: ""`
2. Grep for context: `Grep "ref=\"e18\"" .playwright-mcp/browser-state/dom.html -C 5`
3. Identify help text, required status, aria-describedby relationships
4. Fill the field: `browser_type` or `browser_fill_form`
5. Read the diff: `Read .playwright-mcp/browser-state/diffs/005-type-e18-*.diff`
6. Verify value changed, check for validation errors (aria-invalid, error spans)

### Pattern: Navigate a complex dropdown

1. See combobox in aria tree: `combobox "Country" [ref=e22]: "Select..."`
2. Read DOM to see all options: `Grep "ref=\"e22\"" .playwright-mcp/browser-state/dom.html -C 200`
3. All `<option>` elements are visible in the DOM even if not in the compact aria tree
4. Select option: `browser_select_option`
5. Read diff to verify selection

### Pattern: Debugging a failed submission

1. Submit form: `browser_click` on submit button
2. Read the diff: `Read .playwright-mcp/browser-state/diffs/010-click-submit.diff`
3. Look for new error messages, aria-invalid attributes, changed focus states
4. Grep for error text if present: `Grep "error" .playwright-mcp/browser-state/dom.html -i`
5. Fix validation issues based on error messages

## Summary

- **Aria tree** (in-context): Your primary navigation tool - compact, always available
- **`dom.html`**: Full page context - use Grep/Read when you need more detail
- **`diffs/`**: Action history - see exactly what changed after each step
- **Cross-reference refs**: `[ref=e18]` in aria tree = `ref="e18"` in DOM
- **Grep with context** (`-C N`): See surrounding elements, not just the match
- **Read diffs**: Verify changes without re-reading the entire page
- **Per-instance paths**: When using multiplexer, use the correct instance subdirectory
