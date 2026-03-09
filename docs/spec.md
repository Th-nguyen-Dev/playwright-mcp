# File-Based DOM + Accessibility Tree Hybrid: Architectural Specification

> **Project Codename:** Playwright MCP Enhanced (PME)
> **Status:** DRAFT
> **Created:** 2026-02-11
> **Supersedes:** N/A

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Objectives and Non-Goals](#2-objectives-and-non-goals)
3. [Solution Architecture](#3-solution-architecture)
4. [Component Design](#4-component-design)
5. [Data Flow](#5-data-flow)
6. [File Format Specifications](#6-file-format-specifications)
7. [Tool API Contracts](#7-tool-api-contracts)
8. [Integration with Playwright MCP](#8-integration-with-playwright-mcp)
9. [Configuration](#9-configuration)
10. [Error Handling](#10-error-handling)
11. [Performance Considerations](#11-performance-considerations)
12. [Security Considerations](#12-security-considerations)
13. [Testing Strategy](#13-testing-strategy)
14. [Migration Path](#14-migration-path)
15. [Open Questions](#15-open-questions)

---

## 1. Problem Statement

An AI agent automating job applications across ATS platforms (Greenhouse, Workday, Lever, iCIMS) hits three categories of failure when using Playwright MCP alone:

### 1.1 Context Loss

The accessibility tree omits non-ARIA-linked content: help text, field descriptions, validation error messages, and section groupings that exist only via visual proximity. On ATS platforms, this is the majority of contextual guidance. The AI fills fields blindly without understanding format requirements, conditional logic, or error feedback.

### 1.2 Widget Incompatibility

Playwright MCP supports 5 form input types: `textbox`, `checkbox`, `radio`, `combobox` (native `<select>` only), and `slider`. Real ATS platforms use:
- Custom `<div role="combobox">` with typed search and async dropdown loading (Greenhouse, Workday)
- Tag-based multi-select comboboxes with type-to-filter (Lever)
- Styled overlay dropdowns hiding native selects (iCIMS)
- Iframe-embedded file upload inputs (Greenhouse)
- Pre-filled form fields that require clear-before-type (edit profile flows)

The `selectOption()` call fails on all non-native-select widgets.

### 1.3 Token Bloat (Browser-Use's Problem)

Browser-Use solves context loss by sending the full DOM tree (10-50KB) inline in every conversation turn. This causes:
- Rapid context window exhaustion on multi-step forms (30+ interactions)
- Attention degradation as the model struggles to process large inline payloads
- No incremental update mechanism (full tree rebuilt each time)

### 1.4 The Core Tension

```
Playwright MCP:  Small in-context representation, but missing critical page context
Browser-Use:     Complete page context, but token-expensive inline delivery
```

This specification resolves the tension.

---

## 2. Objectives and Non-Goals

### 2.1 Objectives

| ID | Objective | Success Metric |
|----|-----------|---------------|
| O1 | Full DOM visibility without inline token cost | DOM file on disk, not in conversation |
| O2 | Precise element targeting via accessibility tree refs | `data-ref` attributes injected into DOM file |
| O3 | Custom widget interaction (combobox, file upload, clear-and-type) | Successful form completion on Greenhouse, Workday, Lever |
| O4 | Incremental state awareness via diffs | Diff < 2KB for single-field interactions |
| O5 | Zero new consumption tools | AI uses existing Read/Grep/Glob on `.browser-state/` |
| O6 | Minimal tool count increase | <= 3 new MCP tools added |
| O7 | Backward compatibility | All existing Playwright MCP tools continue to work |

### 2.2 Non-Goals

- **Widget interaction router/middleware** -- The AI reads the DOM file and decides which tool to use. No automation of that decision.
- **Form schema extractor** -- The DOM file + accessibility tree provide schema implicitly. No separate extraction step.
- **Custom caching system** -- The file system IS the cache. No Redis, no in-memory LRU.
- **Custom query tools** -- No `browser_query_dom` or `browser_find_element`. The AI uses Read, Grep, Glob.
- **Vision/screenshot integration** -- Out of scope. The accessibility tree + DOM file provide sufficient structural context for form filling.
- **Multi-browser support** -- Chromium only (CDP required for iframe-aware file upload).
- **Replacing Playwright MCP** -- This is an augmentation layer, not a replacement.

---

## 3. Solution Architecture

### 3.1 High-Level Architecture

```
                          AI AGENT (Claude Code / Cursor / etc.)
                               |
                    MCP Protocol (STDIO / HTTP+SSE)
                               |
          +--------------------+---------------------+
          |                                          |
   Playwright MCP Tools                    New Augmentation Tools
   (existing, unmodified)                  (this specification)
   - browser_navigate                      - browser_select_combobox
   - browser_click                         - browser_upload_file_cdp
   - browser_type                          - browser_clear_and_type
   - browser_snapshot
   - browser_fill_form
   - browser_evaluate
   - browser_press_key
   - ...
          |                                          |
          +--------------------+---------------------+
                               |
                    Response Pipeline Hook
                    (augments existing response flow)
                               |
                +---------------------------+
                |    DOM State Manager      |
                |  - DOM Extraction         |
                |  - DOM Stripping          |
                |  - Ref Injection          |
                |  - Pretty Printing        |
                |  - Diff Generation        |
                |  - File Writing           |
                +---------------------------+
                               |
                    .browser-state/ directory
                    (in AI's workspace root)
                               |
              +----------------+----------------+
              |                |                |
         dom.html      accessibility-    diffs/
         (current     tree.yaml         001-navigate.diff
          stripped    (current compact   002-fill-name.diff
          annotated   YAML with refs)   ...
          DOM)
```

### 3.2 Layered Architecture

```
+---------------------------------------------------------------+
|  Layer 4: MCP Tool Interface                                  |
|  - 3 new tools (combobox, file upload, clear-and-type)        |
|  - Response pipeline hook (post-action file writing)          |
|  - Follows Playwright MCP's defineTabTool / defineTool        |
+---------------------------------------------------------------+
|  Layer 3: DOM State Manager                                   |
|  - Orchestrates extraction -> strip -> annotate -> diff flow  |
|  - Manages .browser-state/ directory lifecycle                |
|  - Maintains action counter for diff sequencing               |
+---------------------------------------------------------------+
|  Layer 2: DOM Processing Pipeline                             |
|  - DOMExtractor: page.content() -> raw HTML                   |
|  - DOMStripper: removes noise (scripts, styles, etc.)         |
|  - RefInjector: maps AX refs to DOM elements via data-ref     |
|  - DOMPrettyPrinter: consistent indentation for clean diffs   |
|  - DiffGenerator: unified diff between old/new DOM states     |
+---------------------------------------------------------------+
|  Layer 1: Browser Automation (Playwright)                     |
|  - page.content() for DOM extraction                          |
|  - page._snapshotForAI() for accessibility tree               |
|  - page.evaluate() for in-browser JS execution                |
|  - CDP session for iframe-aware file upload                   |
+---------------------------------------------------------------+
```

### 3.3 Key Design Principle: Augmentation, Not Replacement

This system wraps around the existing Playwright MCP response pipeline. It does NOT modify any existing Playwright MCP tool handlers. Instead:

1. After any tool that calls `response.setIncludeSnapshot()`, the response pipeline additionally:
   - Extracts and processes the DOM
   - Writes `.browser-state/dom.html` and `.browser-state/accessibility-tree.yaml`
   - Generates a diff if a previous DOM state exists
   - Appends the diff to the response (alongside the existing accessibility snapshot)

2. The 3 new tools are registered as additional tools using the same `defineTool`/`defineTabTool` pattern.

---

## 4. Component Design

### 4.1 DOMExtractor

**Responsibility:** Extract raw HTML from the current page.

**Input:** Playwright `Page` object
**Output:** Raw HTML string

**Implementation:**
```typescript
async function extractDOM(page: Page): Promise<string> {
  return await page.content();
}
```

This is deliberately simple. `page.content()` returns the full serialized DOM including iframes. The heavy lifting happens in the next stages.

### 4.2 DOMStripper

**Responsibility:** Remove noise from raw HTML that provides no value to the AI agent while consuming tokens.

**Input:** Raw HTML string
**Output:** Stripped HTML string

**Stripping rules (ordered by impact):**

| Rule | Removes | Token Savings | Rationale |
|------|---------|---------------|-----------|
| S1 | `<script>` elements (tag + content) | 30-60% | JavaScript code is irrelevant to form filling |
| S2 | `<style>` elements (tag + content) | 10-20% | CSS rules are irrelevant |
| S3 | `<svg>` path data (preserves `<svg>` tag with aria attributes) | 5-15% | SVG path coordinates are noise |
| S4 | Inline `style` attributes | 5-10% | Visual styling is irrelevant |
| S5 | `data-*` attributes (except `data-ref`, `data-testid`) | 3-5% | Framework-internal attributes |
| S6 | `<head>` content (except `<title>`) | 2-5% | Meta tags, link tags are noise |
| S7 | `<noscript>` elements | 1-2% | Fallback content for non-JS browsers |
| S8 | HTML comments | 1-2% | Developer comments |
| S9 | `hidden` elements (`display:none`, `hidden` attribute, `aria-hidden="true"`) | Variable | Elements invisible to user |
| S10 | Empty `class` attributes after stripping | <1% | Clean up |

**Critical preservation rules:**
- ALL text content nodes are preserved (this is the primary advantage over accessibility tree)
- ALL `role`, `aria-*` attributes are preserved
- ALL `id`, `name`, `for`, `type`, `value`, `placeholder`, `required`, `disabled`, `checked`, `selected` attributes are preserved
- ALL `<label>`, `<legend>`, `<fieldset>` elements are preserved
- ALL `<form>`, `<input>`, `<select>`, `<textarea>`, `<button>` elements are preserved
- ALL `href` on `<a>` tags are preserved
- `data-ref` attributes (injected by RefInjector) are preserved
- `data-testid` attributes are preserved (useful for targeting)

**Implementation approach:** In-browser JavaScript execution via `page.evaluate()`. This is significantly faster than parsing HTML in Node.js because:
1. The browser already has the DOM parsed
2. We can traverse the live DOM tree and build stripped HTML directly
3. Hidden element detection uses `getComputedStyle()` which is only available in-browser

### 4.3 RefInjector

**Responsibility:** Map accessibility tree refs (`[ref=eN]`) to corresponding DOM elements, injecting `data-ref="eN"` attributes into the stripped DOM.

**Why this is critical:** The accessibility tree is the AI's navigation map (small, in-context). The DOM file is the AI's detailed reference (large, on-disk). The `data-ref` attributes are the bridge -- the AI can see `[ref=e5]` in the accessibility tree, then `grep data-ref="e5"` in the DOM file to get full context around that element.

**Input:** Page object (with both AX tree and DOM available)
**Output:** DOM string with `data-ref` attributes injected

**Implementation approach:**

The ref injection happens in-browser via `page.evaluate()`. Playwright's accessibility snapshot assigns sequential refs to interactive elements. The injection script:

1. Calls the internal Playwright API to get the mapping between AX node refs and DOM elements
2. For each mapped element, sets `element.setAttribute('data-ref', refValue)`
3. This happens BEFORE DOM extraction, so `page.content()` includes the `data-ref` attributes

Alternative approach (if internal API is not accessible): Use `page.locator('aria-ref=eN')` for each ref to resolve to a DOM element, then use `page.evaluate()` to set the attribute. This is slower (one round-trip per ref) but guaranteed to work with the public API.

**Fallback approach:** Parse both the accessibility YAML and the stripped HTML in Node.js, match elements by heuristics (tag name + accessible name + role), inject attributes via string manipulation. This is the least reliable but most decoupled approach.

The recommended approach is **in-browser injection before extraction**, evaluated in TICKET-003.

### 4.4 DOMPrettyPrinter

**Responsibility:** Format stripped HTML with consistent indentation so that unified diffs are clean and meaningful.

**Input:** Stripped HTML string (possibly minified or inconsistently formatted)
**Output:** Pretty-printed HTML string (one element per line, 2-space indentation)

**Why this matters:** Diffs are the primary mechanism for the AI to understand what changed after an action. If the HTML formatting is inconsistent, diffs will show formatting changes rather than semantic changes, adding noise.

**Rules:**
- One opening tag per line
- 2-space indentation per nesting level
- Self-closing tags on one line
- Short text content inline with parent tag (< 80 chars)
- Long text content on its own line, indented
- Attributes: up to 3 on same line, more than 3 one-per-line
- Consistent attribute ordering: `data-ref`, `id`, `name`, `type`, `role`, `aria-*`, then alphabetical

**Implementation:** In-browser via `page.evaluate()` combined with DOM serialization, or Node.js post-processing. The in-browser approach is preferred because we can serialize the already-stripped DOM tree directly into pretty-printed format, avoiding a parse-serialize roundtrip.

### 4.5 DiffGenerator

**Responsibility:** Generate a unified diff between the previous and current DOM states.

**Input:** Previous DOM string, current DOM string, action description
**Output:** Unified diff string

**Implementation:**
```typescript
import { createTwoFilesPatch } from 'diff';

function generateDiff(
  previousDOM: string,
  currentDOM: string,
  actionDescription: string
): string {
  return createTwoFilesPatch(
    'dom.html',
    'dom.html',
    previousDOM,
    currentDOM,
    `before: ${actionDescription}`,
    `after: ${actionDescription}`,
    { context: 3 }
  );
}
```

Uses the `diff` npm package (well-maintained, MIT licensed, no native dependencies).

**Diff characteristics for common form-filling actions:**

| Action | Expected Diff Size | Content |
|--------|-------------------|---------|
| Fill text field | 50-200 bytes | `value` attribute change on one `<input>` |
| Select dropdown option | 100-500 bytes | `selected` attribute change, possibly dropdown close |
| Check checkbox | 50-100 bytes | `checked` attribute change |
| Navigate to new page | 5-50 KB | Full page replacement (diff is large, but this is expected) |
| Validation error appears | 200-1000 bytes | New error `<span>` or `<div>` added near field |
| Combobox dropdown opens | 500-5000 bytes | New `role=listbox` with `role=option` children |

### 4.6 DOMStateManager

**Responsibility:** Orchestrate the full pipeline and manage the `.browser-state/` directory.

**State:**
- `currentDOM: string | null` -- The current pretty-printed, stripped, annotated DOM
- `actionCounter: number` -- Sequential counter for diff file naming
- `workspacePath: string` -- Path to AI's workspace root (from MCP client info)

**Lifecycle:**

```
Page Load / Navigate
  |
  v
extractDOM() -> stripDOM() -> injectRefs() -> prettyPrint()
  |
  v
If currentDOM exists:
  generateDiff(currentDOM, newDOM) -> write diff file
  |
  v
currentDOM = newDOM
write dom.html
write accessibility-tree.yaml
  |
  v
Return: { diff: string | null, axTree: string }
```

**Directory management:**
```
.browser-state/
  dom.html                              <- overwritten on every state update
  accessibility-tree.yaml               <- overwritten on every state update
  diffs/
    001-navigate-greenhouse-apply.diff  <- append-only
    002-fill-first-name.diff
    003-fill-last-name.diff
    ...
```

**File naming for diffs:**
- Zero-padded 3-digit counter: `001`, `002`, ..., `999`
- Kebab-case action description derived from tool name + primary parameter
- Examples: `001-navigate-greenhouse-apply.diff`, `002-type-first-name.diff`, `003-click-next-button.diff`

**Cleanup:** The `.browser-state/` directory is cleared on:
- MCP server startup
- Browser context creation (new session)
- Explicit `browser_navigate` to a new domain (fresh context)

It is NOT cleared on:
- Same-page interactions (form filling)
- In-page navigation (SPA route changes)
- Tab switches (state is per-tab, but for MVP we track current tab only)

### 4.7 ResponsePipelineHook

**Responsibility:** Hook into Playwright MCP's response serialization to additionally write DOM state files and include diff content.

**Integration point:** The `Response._build()` method in `response.js` is the key integration point. After the existing snapshot section is built, the hook:

1. Checks if a snapshot was included in the response (`this._includeSnapshot !== 'none'`)
2. If yes, triggers the DOMStateManager pipeline
3. Appends a new `### DOM Changes` section to the response with the diff content
4. The diff section is ONLY included when there IS a diff (not on first page load)

**Response format after augmentation:**

```markdown
### Result
Clicked "Submit" button

### Ran Playwright code
```js
await page.getByRole('button', { name: 'Submit' }).click();
```

### Page
- Page URL: https://boards.greenhouse.io/apply
- Page Title: Apply - Software Engineer

### Snapshot
```yaml
- form [ref=e1]:
  - textbox "First Name" [ref=e2]
  - textbox "Last Name" [ref=e3] [value=Smith]
  - combobox "Location" [ref=e4]
```

### DOM Changes
```diff
@@ -45,3 +45,3 @@
   <input data-ref="e3" type="text" name="last_name"
-    value=""
+    value="Smith"
     placeholder="Last Name" required>
```

### Browser State Files
- [DOM snapshot](.browser-state/dom.html)
- [Accessibility tree](.browser-state/accessibility-tree.yaml)
- [Diff: type-last-name](.browser-state/diffs/003-type-last-name.diff)
```

---

## 5. Data Flow

### 5.1 Standard Action Flow (e.g., browser_click, browser_type)

```
1. AI calls browser_click(ref="e5", element="Submit button")
2. Playwright MCP resolves ref -> locator -> click
3. Playwright MCP captures new accessibility snapshot
4. [NEW] ResponsePipelineHook triggers:
   a. page.content() -> raw HTML
   b. page.evaluate(stripDOM) -> stripped HTML
   c. page.evaluate(injectRefs) + page.content() -> annotated HTML
      (or: stripDOM includes ref injection in same evaluate call)
   d. prettyPrint(annotatedHTML) -> formatted HTML
   e. generateDiff(previousDOM, formattedHTML) -> diff
   f. Write .browser-state/dom.html
   g. Write .browser-state/accessibility-tree.yaml
   h. Write .browser-state/diffs/NNN-action.diff
5. Response includes:
   - Existing: result text, playwright code, page info, accessibility snapshot
   - New: diff section, file links
6. AI reads diff inline, knows what changed
7. AI uses Read/Grep on .browser-state/dom.html ONLY when it needs more context
```

### 5.2 Custom Combobox Flow

```
1. AI reads accessibility tree, sees: combobox "Location" [ref=e4]
2. AI reads DOM file (grep data-ref="e4"), sees:
   <div data-ref="e4" role="combobox" aria-autocomplete="list"
        aria-expanded="false" class="css-1234">
     <input type="text" placeholder="Start typing to search...">
   </div>
3. AI recognizes this is a custom combobox (not native <select>)
4. AI calls browser_select_combobox(ref="e4", text="San Francisco")
5. Tool handler:
   a. Click the combobox to focus
   b. Clear existing text (Ctrl+A)
   c. Type "San Francisco" character by character (triggers autocomplete)
   d. Wait 400ms for debounce
   e. Capture fresh DOM snapshot (dropdown now rendered)
   f. Scan for role=option elements in the dropdown
   g. Find matching option via text comparison (exact > contains)
   h. Click the matching option
   i. Return result with new accessibility snapshot + diff
6. Diff shows: combobox value changed, dropdown closed
```

### 5.3 File Upload Flow (Iframe-Aware)

```
1. AI reads DOM file, sees file input inside iframe:
   <iframe src="https://api.greenhouse.io/embed/...">
     <input data-ref="e12" type="file" name="resume">
   </iframe>
2. AI calls browser_upload_file_cdp(ref="e12", path="/path/to/resume.pdf")
3. Tool handler:
   a. Resolve ref to DOM element via Playwright locator
   b. Determine if element is in an iframe
   c. If iframe: get CDP session for the iframe's execution context
   d. Use CDP DOM.setFileInputFiles to set the file
   e. Return result with snapshot + diff
4. Diff shows: file input now has a file attached
```

---

## 6. File Format Specifications

### 6.1 dom.html

```html
<!-- .browser-state/dom.html -->
<!-- Generated: 2026-02-11T15:30:45.123Z -->
<!-- URL: https://boards.greenhouse.io/company/jobs/12345/apply -->
<!-- Tool: browser_click ref=e5 -->
<html lang="en">
  <body>
    <div id="app-container">
      <header>
        <h1>Software Engineer - San Francisco</h1>
        <p>Company Name Inc.</p>
      </header>
      <main>
        <form id="application-form" action="/submit" method="POST">
          <fieldset>
            <legend>Personal Information</legend>
            <div class="form-group">
              <label for="first_name">First Name *</label>
              <input data-ref="e2" id="first_name" type="text"
                name="first_name" required placeholder="First Name">
              <span class="help-text">As it appears on your government ID</span>
            </div>
            <div class="form-group">
              <label for="last_name">Last Name *</label>
              <input data-ref="e3" id="last_name" type="text"
                name="last_name" required placeholder="Last Name" value="Smith">
            </div>
            <div class="form-group">
              <label for="location">Location *</label>
              <div data-ref="e4" role="combobox" aria-autocomplete="list"
                aria-expanded="false">
                <input type="text" placeholder="Start typing to search...">
              </div>
              <span class="help-text">
                City where you are based. Remote candidates: enter your home city.
              </span>
            </div>
          </fieldset>
          <fieldset>
            <legend>Resume</legend>
            <div class="form-group">
              <label>Resume/CV *</label>
              <div class="file-upload-area">
                <input data-ref="e12" type="file" name="resume"
                  accept=".pdf,.doc,.docx">
                <span class="help-text">PDF, DOC, or DOCX. Max 5MB.</span>
              </div>
            </div>
          </fieldset>
          <button data-ref="e15" type="submit">Submit Application</button>
        </form>
      </main>
    </div>
  </body>
</html>
```

Key characteristics:
- HTML comment header with metadata (timestamp, URL, last action)
- `<head>` content stripped except `<title>` (which appears in page info anyway)
- `data-ref` attributes on interactive elements matching AX tree refs
- All help text, labels, and descriptions preserved
- Consistent 2-space indentation
- Attributes formatted for readability

### 6.2 accessibility-tree.yaml

This is the EXISTING Playwright MCP accessibility snapshot format. No changes. It stays in-context as the navigation map.

```yaml
- form [ref=e1]:
  - group "Personal Information":
    - textbox "First Name" [required] [ref=e2]
    - textbox "Last Name" [required] [ref=e3] [value=Smith]
    - combobox "Location" [required] [ref=e4]
  - group "Resume":
    - button "Upload Resume" [ref=e12]
  - button "Submit Application" [ref=e15]
```

### 6.3 Diff Files

Standard unified diff format:

```diff
--- dom.html	before: type-last-name
+++ dom.html	after: type-last-name
@@ -22,7 +22,7 @@
             <div class="form-group">
               <label for="last_name">Last Name *</label>
               <input data-ref="e3" id="last_name" type="text"
-                name="last_name" required placeholder="Last Name" value="">
+                name="last_name" required placeholder="Last Name" value="Smith">
             </div>
```

---

## 7. Tool API Contracts

### 7.1 browser_select_combobox

**Purpose:** Handle custom combobox widgets that use TYPE-WAIT-SCAN-CLICK patterns instead of native `<select>` elements.

```typescript
{
  name: 'browser_select_combobox',
  description: 'Select an option from a custom combobox/autocomplete dropdown. ' +
    'Use this for custom dropdown inputs (role=combobox) like Greenhouse, Workday, ' +
    'and Lever ATS forms. Types the search text to trigger the dropdown, waits for ' +
    'options to appear, then clicks the matching option. ' +
    'Do NOT use this for native <select> elements (use browser_select_option instead).',
  inputSchema: z.object({
    ref: z.string().describe('Exact ref of the combobox element from the page snapshot'),
    element: z.string().optional().describe('Human-readable element description'),
    text: z.string().describe('Text to search for and select from the dropdown options'),
    retries: z.number().optional().default(3).describe('Number of retry attempts to find dropdown options'),
    delay: z.number().optional().default(400).describe('Milliseconds to wait after typing for dropdown to appear')
  }),
  type: 'input',
  capability: 'core'
}
```

**Algorithm:**
1. Resolve `ref` to locator via `tab.refLocator()`
2. Click the combobox to focus
3. `Ctrl+A` to select existing text
4. Type `text` using `pressSequentially()` (character-by-character triggers autocomplete handlers)
5. Wait `delay` ms
6. Capture fresh accessibility snapshot
7. Scan for `role=option` elements in the updated tree
8. Find best match: exact text match > contains match
9. Click the matching option via its ref
10. If no match found, retry up to `retries` times with increasing delay (400ms, 800ms, 1200ms)
11. Return result + include snapshot

**Error cases:**
- Ref not found -> "Ref eN not found. Try capturing new snapshot."
- No options appear after retries -> "No dropdown options found after typing 'X' into combobox eN. The element may not be an autocomplete combobox."
- No matching option -> "No option matching 'X' found. Available options: [list first 10]"

### 7.2 browser_upload_file_cdp

**Purpose:** Upload files to file input elements, including those inside iframes, using CDP for cross-frame support.

```typescript
{
  name: 'browser_upload_file_cdp',
  description: 'Upload a file to a file input element using CDP. ' +
    'Works with file inputs inside iframes (e.g., Greenhouse ATS embedded forms). ' +
    'Use this when the standard browser_file_upload requires a file chooser dialog. ' +
    'This tool directly sets the file on the input element without a dialog.',
  inputSchema: z.object({
    ref: z.string().describe('Ref of the file input element, or a nearby element (will search for the closest file input)'),
    element: z.string().optional().describe('Human-readable element description'),
    path: z.string().describe('Absolute path to the file to upload')
  }),
  type: 'action',
  capability: 'core'
}
```

**Algorithm:**
1. Validate file exists and is non-empty
2. Resolve ref to DOM element
3. If the element is not `<input type="file">`, search nearby DOM:
   a. Check children (depth 3)
   b. Check siblings
   c. Check parent's children
   d. Walk up 4 levels, checking at each level
   e. Last resort: find any `<input type="file">` on the page
4. Determine if the file input is in an iframe:
   a. Use `page.evaluate()` to check if element is in a cross-origin frame
   b. If yes, use Playwright's frame locator or CDP session targeting
5. Set file via CDP `DOM.setFileInputFiles` with correct session ID
6. Return result + include snapshot

### 7.3 browser_clear_and_type

**Purpose:** Replace existing text in a form field by selecting all and typing new text.

```typescript
{
  name: 'browser_clear_and_type',
  description: 'Clear an input field completely, then type new text. ' +
    'Use this instead of browser_type when the field already has a value. ' +
    'Selects all existing text (Ctrl+A) and replaces it by typing the new text.',
  inputSchema: z.object({
    ref: z.string().describe('Exact ref of the input element from the page snapshot'),
    element: z.string().optional().describe('Human-readable element description'),
    text: z.string().describe('New text to type after clearing'),
    submit: z.boolean().optional().describe('Whether to press Enter after typing')
  }),
  type: 'input',
  capability: 'core'
}
```

**Algorithm:**
1. Resolve ref to locator
2. Click the element to focus
3. `Ctrl+A` to select all
4. Short delay (100ms)
5. Type new text via `locator.fill()` or `pressSequentially()` depending on whether `slowly` mode is needed
6. If `submit`, press Enter and wait for completion
7. Return result + include snapshot

---

## 8. Integration with Playwright MCP

### 8.1 Integration Strategy: Wrapper Package

The augmentation is built as a **wrapper layer** around the existing `@playwright/mcp` package. It does NOT modify Playwright MCP's compiled `.js` files in `node_modules/`. Instead:

```
New Package: @playwright-mcp-enhanced/server
  |
  |- Imports @playwright/mcp's createConnection
  |- Creates a BrowserServerBackend with additional tools
  |- Wraps the response serialization to add DOM state management
  |- Exports enhanced createConnection
```

**Why a wrapper instead of a fork:**
- Playwright MCP is in the Playwright monorepo and uses pre-compiled `.js` files
- Forking the monorepo for 3 new tools creates unsustainable maintenance burden
- The wrapper approach lets us upgrade Playwright MCP independently
- Tool registration is additive (we add tools to the tool list)
- Response augmentation hooks into the public response API

### 8.2 Tool Registration

The 3 new tools are added to the tool array alongside existing Playwright MCP tools:

```typescript
import { browserTools } from 'playwright/lib/mcp/browser/tools';
import { selectCombobox } from './tools/combobox';
import { uploadFileCDP } from './tools/file-upload';
import { clearAndType } from './tools/clear-and-type';

const enhancedTools = [
  ...browserTools,
  selectCombobox,
  uploadFileCDP,
  clearAndType
];
```

Each tool follows the existing `defineTabTool` pattern:
- Takes `(tab, params, response)` arguments
- Uses `tab.refLocator()` for element resolution
- Calls `response.setIncludeSnapshot()` to trigger snapshot after action
- Adds Playwright code via `response.addCode()`

### 8.3 Response Pipeline Hook

The response pipeline hook wraps `Response.serialize()`:

```typescript
class EnhancedResponse extends Response {
  constructor(context, toolName, toolArgs, relativeTo, domStateManager) {
    super(context, toolName, toolArgs, relativeTo);
    this._domStateManager = domStateManager;
  }

  async serialize() {
    // Let the original response build all sections
    const result = await super.serialize();

    // If a snapshot was included, also write DOM state files
    if (this._includeSnapshot !== 'none') {
      const domResult = await this._domStateManager.captureAndDiff(
        this._context.currentTabOrDie().page,
        this.toolName,
        this.toolArgs
      );

      // Append DOM change section to response text
      if (domResult.diff) {
        const textContent = result.content.find(c => c.type === 'text');
        if (textContent) {
          textContent.text += `\n### DOM Changes\n\`\`\`diff\n${domResult.diff}\n\`\`\``;
          textContent.text += `\n### Browser State Files`;
          textContent.text += `\n- [DOM snapshot](.browser-state/dom.html)`;
          textContent.text += `\n- [Diff](${domResult.diffPath})`;
        }
      }
    }

    return result;
  }
}
```

### 8.4 BrowserServerBackend Enhancement

```typescript
class EnhancedBrowserServerBackend extends BrowserServerBackend {
  private _domStateManager: DOMStateManager;

  constructor(config, factory, options) {
    // Pass enhanced tool list
    super(config, factory, { ...options, allTools: true });
    this._domStateManager = new DOMStateManager(config);
  }

  async callTool(name, rawArguments) {
    // Use EnhancedResponse instead of Response
    // ... override response creation to use EnhancedResponse
  }
}
```

---

## 9. Configuration

### 9.1 New Configuration Options

```typescript
interface EnhancedConfig {
  domState: {
    enabled: boolean;              // Default: true
    directory: string;             // Default: '.browser-state'
    stripRules: {
      scripts: boolean;            // Default: true
      styles: boolean;             // Default: true
      svgPaths: boolean;           // Default: true
      inlineStyles: boolean;       // Default: true
      dataAttributes: boolean;     // Default: true (except data-ref, data-testid)
      headContent: boolean;        // Default: true (except <title>)
      hiddenElements: boolean;     // Default: true
      comments: boolean;           // Default: true
    };
    diffs: {
      enabled: boolean;            // Default: true
      contextLines: number;        // Default: 3
      maxDiffFiles: number;        // Default: 999
      inlineInResponse: boolean;   // Default: true
    };
    prettyPrint: {
      indentSize: number;          // Default: 2
      maxInlineTextLength: number; // Default: 80
      maxInlineAttributes: number; // Default: 3
    };
  };
}
```

### 9.2 CLI Options

```
--dom-state              Enable DOM state file writing (default: true)
--dom-state-dir <dir>    Directory for DOM state files (default: .browser-state)
--no-dom-diffs           Disable diff generation
--no-dom-inline-diffs    Disable inline diffs in responses (still writes diff files)
```

### 9.3 Environment Variables

```
PLAYWRIGHT_MCP_DOM_STATE=true|false
PLAYWRIGHT_MCP_DOM_STATE_DIR=.browser-state
PLAYWRIGHT_MCP_DOM_DIFFS=true|false
PLAYWRIGHT_MCP_DOM_INLINE_DIFFS=true|false
```

---

## 10. Error Handling

### 10.1 DOM Extraction Failures

If `page.content()` or `page.evaluate()` fails (e.g., page crashed, navigation in progress):
- Log warning to stderr
- Skip DOM file writing for this action
- Return normal Playwright MCP response without DOM augmentation
- Set `_needsFullSnapshot` flag for next action

### 10.2 File System Failures

If writing to `.browser-state/` fails (permissions, disk full):
- Log warning to stderr
- Return normal Playwright MCP response without DOM augmentation
- Retry on next action

### 10.3 Diff Generation Failures

If diff generation throws (e.g., out of memory on very large DOMs):
- Write the new `dom.html` (skip diff)
- Log warning
- Return response without diff section

### 10.4 Custom Tool Failures

Each custom tool follows the pattern of returning error messages as text results rather than throwing. This matches Browser-Use's approach and gives the AI agent error context to retry:

```typescript
// Good: return error as text
response.addTextResult(`Error: No dropdown option matching "${text}" found.`);

// Bad: throw (gives less context to the AI)
throw new Error('Option not found');
```

---

## 11. Performance Considerations

### 11.1 DOM Extraction Timing

| Operation | Expected Time | Mitigation |
|-----------|--------------|------------|
| `page.content()` | 5-20ms | N/A (fast) |
| `page.evaluate(stripDOM)` | 10-50ms | Single evaluate call for strip + pretty-print |
| Ref injection | 5-20ms | Batch all refs in single evaluate |
| `generateDiff()` | 1-10ms | `diff` library is optimized |
| File writes (3 files) | 1-5ms | Async writes, non-blocking |
| **Total overhead per action** | **22-105ms** | Well within acceptable latency |

Playwright MCP's existing `page._snapshotForAI()` takes ~50-100ms. The DOM state pipeline adds comparable overhead. Total tool response time increases from ~150ms to ~250ms.

### 11.2 DOM File Size

| Page Complexity | Raw HTML | Stripped HTML | Ratio |
|----------------|----------|---------------|-------|
| Simple form (10 fields) | 50 KB | 5-10 KB | 5-10x reduction |
| Complex form (50 fields) | 200 KB | 20-40 KB | 5x reduction |
| Full SPA page | 500 KB | 50-100 KB | 5-10x reduction |

The stripped DOM is comparable in size to the full Browser-Use DOM tree, but it is on disk rather than in the context window. The AI only reads it when needed.

### 11.3 Diff Size

For single-field form interactions, diffs are typically 100-500 bytes. This is small enough to include inline in every response without token concerns.

For page navigations, diffs can be 10-50KB (essentially the full page). In these cases, the diff file is written but the inline response should be truncated or omitted, showing only the file link.

**Diff size thresholds:**
- < 2 KB: Include full diff inline in response
- 2-10 KB: Include first 2 KB inline with "... truncated, see file for full diff" message
- > 10 KB: Include only "Page changed significantly. See [diff file link] for details."

---

## 12. Security Considerations

### 12.1 File Path Security

All file writes go to `.browser-state/` within the workspace root. The workspace root is determined by:
1. MCP client's `roots` configuration
2. Fallback: `process.cwd()`

No file writes outside the workspace are allowed. Path traversal is prevented by using `path.resolve()` and checking the resolved path starts with the workspace root.

### 12.2 Secret Redaction in DOM Files

Playwright MCP's secret redaction applies to response text. DOM files written to disk may contain secrets (e.g., pre-filled email addresses, API keys in hidden inputs). The DOMStripper should:
1. Apply the same secret redaction as the response pipeline
2. Replace matched secrets with `<redacted:secretName>` in the DOM file

### 12.3 No New Attack Surface

The 3 new tools use the same element targeting mechanism (ref-based) as existing tools. They do not introduce new ways to execute arbitrary code beyond what `browser_evaluate` already provides.

---

## 13. Testing Strategy

### 13.1 Unit Tests

| Component | Test Cases |
|-----------|-----------|
| DOMStripper | Scripts removed, styles removed, SVG paths removed, interactive elements preserved, help text preserved, hidden elements removed, aria attributes preserved |
| RefInjector | Refs injected on interactive elements, non-interactive elements skipped, iframe elements handled |
| DOMPrettyPrinter | Consistent indentation, attribute ordering, inline vs block text |
| DiffGenerator | Empty diff for identical DOMs, single-line change, multi-line change, large change truncation |
| DOMStateManager | Directory creation, file writing, action counter increment, cleanup on navigate |

### 13.2 Integration Tests

| Scenario | Test Page | Assertions |
|----------|-----------|------------|
| Basic form fill | Static HTML form | DOM file written, diff shows value change, refs match AX tree |
| Custom combobox | Mock Greenhouse-style combobox | TYPE-WAIT-SCAN-CLICK succeeds, correct option selected |
| Native select | Standard `<select>` | `browser_select_option` still works, diff shows selection change |
| File upload in iframe | Iframe with file input | File set via CDP, works cross-frame |
| Clear and type | Pre-filled input | Old value replaced, diff shows change |
| Page navigation | Navigate between pages | DOM file replaced, large diff or summary |
| Validation error | Form with JS validation | Error text appears in DOM file and diff |

### 13.3 ATS Platform Tests (Manual/E2E)

| Platform | Test Scenario |
|----------|--------------|
| Greenhouse | Full application flow: personal info, location combobox, resume upload, custom questions |
| Workday | Department autocomplete, multi-step form, conditional fields |
| Lever | Skills multi-select, cover letter, apply button |

---

## 14. Migration Path

### 14.1 Phase 1: Foundation (Tickets 001-005)

Build the DOM processing pipeline and file management. No changes to tool behavior yet. DOM files are written alongside existing responses.

### 14.2 Phase 2: Response Augmentation (Tickets 006-007)

Hook into the response pipeline. Diffs appear inline. File links appear in responses. The AI starts seeing DOM changes without any behavior change.

### 14.3 Phase 3: Custom Tools (Tickets 008-010)

Add the 3 new tools. The AI can now handle custom comboboxes, iframe file uploads, and pre-filled fields.

### 14.4 Phase 4: Polish (Tickets 011-012)

Configuration, testing, documentation. Production readiness.

---

## 15. Open Questions

| ID | Question | Impact | Decision Needed By |
|----|----------|--------|-------------------|
| Q1 | Should ref injection happen in-browser (before extraction) or in Node.js (after extraction)? | Reliability of ref-to-DOM mapping | TICKET-003 |
| Q2 | Should the wrapper package live in the playwright-mcp repo or as a separate npm package? | Build/deploy process | TICKET-001 |
| Q3 | Should diffs use unified format or a custom format optimized for LLM consumption? | Token efficiency of diffs | TICKET-005 |
| Q4 | How to handle SPAs where page.content() returns minimal HTML and content is injected via JS? | DOM extraction completeness | TICKET-002 |
| Q5 | Should per-tab DOM tracking be implemented in v1, or current-tab-only? | Multi-tab form workflows | Deferred to v2 |
| Q6 | What happens when the AI's workspace has no write permissions? | Graceful degradation | TICKET-006 |
