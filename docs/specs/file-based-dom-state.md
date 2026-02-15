# File-Based DOM State for Playwright MCP

## Technical Design Document

---

## 1. What We're Building

A plugin for the Playwright MCP server that gives AI agents full DOM context alongside the accessibility tree, using the filesystem as the interface.

After every browser action, the MCP server:
1. Extracts the full page DOM, strips noise, pretty-prints it
2. Injects `ref="eN"` attributes from the accessibility tree into the DOM elements
3. Writes the combined DOM to a file in the AI's workspace
4. Diffs it against the previous version and saves the diff to a trail folder
5. Returns the diff inline in the tool response

The AI uses the accessibility tree (already returned by existing tools) as the **navigation map** for targeting elements. When it needs more context — help text, widget structure, surrounding layout, dropdown options — it reads or greps the DOM file using its existing file tools. The diff trail lets it look back at what each action changed.

```
.playwright-mcp/browser-state/
  dom.html                     ← always current page DOM, stripped + annotated with refs
  accessibility-tree.yaml      ← always current aria snapshot
  diffs/
    001-navigate.diff           ← what changed after each action
    002-click-e14.diff
    003-fill-form.diff
```

---

## 2. Why Files

The AI already knows how to use files. It can:
- `Read .playwright-mcp/browser-state/dom.html` — see the full DOM
- `Read .playwright-mcp/browser-state/dom.html` with offset/limit — see a specific section
- `Grep "ref=\"e8\"" .playwright-mcp/browser-state/dom.html` with context — find an element and its surroundings
- `Grep "help-text" .playwright-mcp/browser-state/dom.html` — find all help text
- `Read .playwright-mcp/browser-state/diffs/003-fill-form.diff` — see what an action changed
- `Glob .playwright-mcp/browser-state/diffs/*.diff` — see full action history

No new tools needed on the consumption side. The AI controls its own token budget — it reads what it needs, when it needs it. Smart model reads less. Confused about a field reads more.

---

## 3. How Aria Refs Work in Playwright (The Key Insight)

All code lives in the monorepo we forked at `playwright/`.

### 3.1 Ref Assignment

When `_snapshotForAI()` is called, it runs `generateAriaTree()` in the browser's injected script context. For every visible, interactable element, `computeAriaRef()` runs:

**File:** `packages/injected/src/ariaSnapshot.ts` line 203-216

```typescript
function computeAriaRef(ariaNode: aria.AriaNode, options: InternalOptions) {
  if (options.refs === 'none')
    return;
  if (options.refs === 'interactable' && (!ariaNode.box.visible || !ariaNode.receivesPointerEvents))
    return;

  const element = ariaNodeElement(ariaNode);
  let ariaRef = (element as any)._ariaRef as AriaRef | undefined;
  if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) {
    ariaRef = { role: ariaNode.role, name: ariaNode.name, ref: (options.refPrefix ?? '') + 'e' + (++lastRef) };
    (element as any)._ariaRef = ariaRef;
  }
  ariaNode.ref = ariaRef.ref;
}
```

This stores `_ariaRef` as a **plain JavaScript property on the DOM element**. After `_snapshotForAI()` runs, every interactable element in the page has:

```javascript
element._ariaRef = { role: "textbox", name: "First Name", ref: "e14" }
```

### 3.2 Ref Stability

Refs are **stable across snapshots**. The code checks if the element already has a `_ariaRef` with the same `role` and `name` — if so, it reuses the existing ref. A new ref is only generated if the role or name changed. This means `ref="e14"` always points to the same "First Name" textbox across actions.

### 3.3 Ref Resolution

When the AI calls a tool with `ref: "e14"`, Playwright resolves it via the `aria-ref` selector engine:

**File:** `packages/injected/src/injectedScript.ts` line 709-715

```typescript
_createAriaRefEngine() {
  const queryAll = (root: SelectorRoot, selector: string): Element[] => {
    const result = this._lastAriaSnapshotForQuery?.elements?.get(selector);
    return result && result.isConnected ? [result] : [];
  };
  return { queryAll };
}
```

It looks up the ref in `_lastAriaSnapshotForQuery.elements` — a `Map<string, Element>` built during `generateAriaTree()` (line 136):

```typescript
if (childAriaNode.ref) {
  snapshot.elements.set(childAriaNode.ref, element);  // "e14" -> <input> element
  snapshot.refs.set(element, childAriaNode.ref);       // <input> element -> "e14"
}
```

### 3.4 What This Means for Us

After `captureSnapshot()` runs (which happens during `Response._build()` for every tool call), all interactable DOM elements have `._ariaRef.ref` set. Our DOM extractor can run immediately after and do:

```javascript
document.querySelectorAll('*').forEach(el => {
  if (el._ariaRef)
    el.setAttribute('ref', el._ariaRef.ref);
});
```

Then we serialize the DOM. The refs in the DOM file match the refs in the accessibility tree. The AI can cross-reference freely.

---

## 4. The Snapshot Call Chain

Understanding exactly when and where snapshots happen is critical for knowing where to hook our DOM extraction.

```
BrowserServerBackend.callTool(name, args)           // browserServerBackend.ts:57
  tool.handle(context, params, response)             // dispatched to tool handler
    response.setIncludeSnapshot()                    // tool requests snapshot
    tab.waitForCompletion(async () => { ... })       // action + settle
  response.serialize()                               // response.ts:127
    _build()                                         // response.ts:169
      tab.captureSnapshot(relativeTo)                // tab.ts:345  <-- SNAPSHOT HAPPENS HERE
        page._snapshotForAI({ track: 'response' })  // playwright-core, triggers injected script
          generateAriaTree(body, { mode: 'ai' })     // ariaSnapshot.ts:79
            computeAriaRef() for each element        // sets element._ariaRef
          renderAriaTree()                           // produces YAML string
        returns { ariaSnapshot: full, ariaSnapshotDiff: incremental }
      // At this point, all DOM elements have ._ariaRef set
      // *** THIS IS WHERE WE HOOK IN ***
      sections.push(Snapshot section)
    formats sections as markdown
  returns CallToolResult to agent
```

The key: `captureSnapshot()` populates `._ariaRef` on all elements as a side effect of generating the aria tree. Our DOM extraction runs right after, in the same `_build()` method.

---

## 5. What the DOM File Looks Like

### 5.1 Raw DOM (what the browser has)

```html
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Apply: Software Engineer - Workday</title>
  <link rel="stylesheet" href="/assets/main.css">
  <script src="/assets/app.bundle.js"></script>
  <style>.form-group { margin: 16px 0; } .help-text { color: #666; font-size: 12px; }</style>
</head>
<body>
  <nav class="top-nav" role="banner">
    <a href="/" class="logo"><img src="/logo.png" alt="Company Logo"></a>
    <div class="nav-links">
      <a href="/home">Home</a>
      <a href="/applications">My Applications</a>
      <button onclick="signOut()" data-analytics="sign-out-btn" data-testid="signout">Sign Out</button>
    </div>
  </nav>
  <main>
    <h1>Apply: Software Engineer</h1>
    <form id="application-form" action="/api/apply" method="POST">
      <div class="form-section">
        <h2>Personal Information</h2>
        <div class="form-group">
          <label for="first-name">First Name <span class="required">*</span></label>
          <input id="first-name" type="text" name="firstName" required aria-required="true" value="">
          <span class="help-text">Enter your legal first name</span>
        </div>
        <div class="form-group">
          <label for="email">Email <span class="required">*</span></label>
          <input id="email" type="email" name="email" required aria-required="true" aria-describedby="email-help" value="">
          <span id="email-help" class="help-text">We'll use this to contact you about your application</span>
        </div>
        <div class="form-group">
          <label for="country">Country</label>
          <select id="country" name="country">
            <option value="">Select...</option>
            <option value="us">United States</option>
            <option value="uk">United Kingdom</option>
            <option value="ca">Canada</option>
            <!-- ... 195 more options ... -->
          </select>
        </div>
      </div>
      <button type="submit" class="btn-primary">Submit Application</button>
    </form>
  </main>
  <footer role="contentinfo">
    <a href="/privacy">Privacy Policy</a>
    <span>© 2026 Company</span>
  </footer>
  <script>
    // 500 lines of application JavaScript
    document.getElementById('country').addEventListener('change', function() { ... });
  </script>
</body>
</html>
```

### 5.2 Stripped + Annotated DOM (what we write to `dom.html`)

```html
<body>
  <nav role="banner" ref="e2">
    <a href="/" ref="e3">
      Company Logo
    </a>
    <div>
      <a href="/home" ref="e5">Home</a>
      <a href="/applications" ref="e6">My Applications</a>
      <button ref="e8">Sign Out</button>
    </div>
  </nav>
  <main>
    <h1 ref="e10">Apply: Software Engineer</h1>
    <form id="application-form">
      <div>
        <h2 ref="e12">Personal Information</h2>
        <div>
          <label for="first-name">First Name <span>*</span></label>
          <input id="first-name"
                 type="text"
                 name="firstName"
                 required
                 aria-required="true"
                 value=""
                 ref="e14">
          <span class="help-text">Enter your legal first name</span>
        </div>
        <div>
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
        </div>
        <div>
          <label for="country">Country</label>
          <select id="country" name="country" ref="e22">
            <option value="">Select...</option>
            <option value="us">United States</option>
            <option value="uk">United Kingdom</option>
            <option value="ca">Canada</option>
            <!-- ... 195 more options ... -->
          </select>
        </div>
      </div>
      <button type="submit" ref="e51">Submit Application</button>
    </form>
  </main>
  <footer role="contentinfo" ref="e52">
    <a href="/privacy" ref="e53">Privacy Policy</a>
    © 2026 Company
  </footer>
</body>
```

### 5.3 What Gets Stripped

| Removed | Why |
|---------|-----|
| `<head>` entirely | Meta tags, link tags, title — not useful for interaction |
| `<script>` elements | Application JS is noise |
| `<style>` elements | CSS rules are noise |
| `<svg>` internals | Path data is noise, keep the `<svg>` shell if it has a ref |
| `<noscript>` | Not rendered |
| Inline `style` attributes | Visual styling, not semantic |
| `data-*` attributes | Analytics, test IDs, framework internals |
| `onclick`, `onchange`, etc. | Event handlers are noise |
| `class` attribute | **Keep selectively** — remove framework-generated classes (`css-a1b2c3`, `sc-dkPtRN`), keep semantic ones (`help-text`, `error-message`, `form-group`) |
| Hidden elements (`display:none`, `aria-hidden="true"`) | Not visible to user — but **keep if they have semantic content** (e.g., error messages that become visible on validation) |
| Comments | Noise |

### 5.4 What Gets Kept

| Kept | Why |
|------|-----|
| All semantic HTML structure | The AI needs to understand page layout |
| `id`, `name`, `for` attributes | Form associations, anchor targets |
| `type`, `required`, `placeholder`, `value` | Form field properties |
| `aria-*` attributes | Accessibility semantics |
| `role` attribute | Widget type information |
| `href` on links | Navigation targets |
| `action`, `method` on forms | Form submission info |
| `ref` attribute (injected) | Cross-reference with accessibility tree — matches `[ref=eN]` in aria snapshot |
| Text content | Labels, help text, error messages, headings |
| Semantic `class` names | `.help-text`, `.error`, `.required` help the AI understand context |

### 5.5 Pretty-Printing Rules (Critical for Clean Diffs)

The DOM MUST be formatted deterministically with one attribute per line for elements with multiple attributes. This ensures that when a `value` changes, only that one line shows up in the diff.

Rules:
- One element per line for simple elements: `<a href="/home" ref="e5">Home</a>`
- Multi-attribute elements get one attribute per line (indented):
  ```html
  <input id="first-name"
         type="text"
         name="firstName"
         required
         aria-required="true"
         value=""
         ref="e14">
  ```
- Consistent 2-space indentation for nesting
- Self-closing tags for void elements: `<input ...>`, `<br>`, `<img ...>`
- Text content on same line as tag if short: `<a href="/">Home</a>`
- Text content on next line if long (>80 chars)
- **Canonical attribute ordering** enforced by `AIDomBuilder._serializeAttributes()`:
  `id` → `type` → `name` → `role` → `aria-*` → `href` → `action` → `method` → `for` → `value` → `placeholder` → `class` → (other) → `ref` (always last)
  This keeps diffs stable — attributes don't shift position across snapshots, and `ref` is always at the end for easy scanning.

This formatting means after `browser_type` fills the first name field, the diff is:

```diff
@@ -15,7 +15,7 @@
          <input id="first-name"
                 type="text"
                 name="firstName"
                 required
                 aria-required="true"
-                value=""
+                value="John"
                 ref="e14">
```

One line changed. The AI sees exactly what happened.

---

## 6. The Accessibility Tree File

Alongside `dom.html`, we write `accessibility-tree.yaml` — the same aria snapshot that the existing `browser_snapshot` tool returns. This is the compact ref map.

```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - link "Company Logo" [ref=e3]
    - link "Home" [ref=e5]
    - link "My Applications" [ref=e6]
    - button "Sign Out" [ref=e8]
  - main:
    - heading "Apply: Software Engineer" [level=1] [ref=e10]
    - heading "Personal Information" [level=2] [ref=e12]
    - textbox "First Name" [ref=e14]: ""
    - textbox "Email" [ref=e18]: ""
    - combobox "Country" [ref=e22]:
      - option "Select..."
      - option "United States"
      - option "United Kingdom"
      - option "Canada"
    - button "Submit Application" [ref=e51]
  - contentinfo [ref=e52]:
    - link "Privacy Policy" [ref=e53]
```

The AI gets this in-context (it's the normal tool response). But it's also on disk for reference. The `ref="e14"` in `dom.html` maps to `textbox "First Name" [ref=e14]` in the tree.

---

## 7. The Diff Trail

### 7.1 How Diffs Work

After each action:
1. New DOM extracted and formatted
2. Diffed against current `dom.html` using unified diff
3. Diff saved to `diffs/NNN-action-description.diff`
4. `dom.html` overwritten with new version
5. Diff content returned inline in the tool response

### 7.2 Diff Naming

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

The counter ensures ordering. The action description comes from `toolName` + key args from `toolArgs` (the ref and/or value).

### 7.3 What a Diff Looks Like

After typing "John" into the first name field:

```diff
--- dom.html	(before click-e14)
+++ dom.html	(after type-e14-John)
@@ -15,7 +15,7 @@
          <input id="first-name"
                 type="text"
                 name="firstName"
                 required
                 aria-required="true"
-                value=""
+                value="John"
                 ref="e14">
```

After a validation error appears:

```diff
--- dom.html	(before type-e18-bad-email)
+++ dom.html	(after type-e18-bad-email)
@@ -22,9 +22,11 @@
          <input id="email"
                 type="email"
                 name="email"
                 required
                 aria-required="true"
+                aria-invalid="true"
                 aria-describedby="email-help"
-                value=""
+                value="not-an-email"
                 ref="e18">
-         <span id="email-help" class="help-text">We'll use this to contact you about your application</span>
+         <span id="email-help" class="help-text">We'll use this to contact you about your application</span>
+         <span class="error-message" role="alert">Please enter a valid email address</span>
```

The AI sees: the value changed, `aria-invalid` appeared, and an error message element was added. All from a few lines of diff.

---

## 8. Integration Into the Codebase

### 8.1 Where We Hook In

The hook point is `Response._build()` in `browser/response.ts`. This method already calls `tab.captureSnapshot()` which populates `._ariaRef` on all DOM elements. We add our DOM extraction and file writing right after.

**Current `_build()` flow (response.ts:169-231):**

```
_build()
  1. Error section
  2. Result section
  3. Code section
  4. tab.captureSnapshot()        <-- aria refs get populated here
  5. Open tabs section
  6. Page section
  7. Modal state section
  8. Snapshot section (aria YAML)
  9. Events section
  return sections
```

**Modified `_build()` flow:**

```
_build()
  1. Error section
  2. Result section
  3. Code section
  4. tab.captureSnapshot()           ← aria refs populated on DOM elements
  5. Open tabs section
  6. Page section
  7. Modal state section
  8. Snapshot section (aria YAML)
  9. *** DOM State section (NEW) ***  ← domState.update() called here
  10. Events section
  return sections
```

**End-to-end pipeline for step 9 — from browser DOM to file on disk:**

```
Response._build()
  │
  │ calls domState.update(page, context, toolName, toolArgs, ariaSnapshot)
  │
  ├─ 1. _ensureStateDir(context)
  │     Check env vars (multiplexer) or hasExplicitRoots() (standalone)
  │     → returns directory path or undefined (bail out)
  │
  ├─ 2. extractFullDom(page)                              [Node.js]
  │     │
  │     ├─ page.evaluate(AIDomBuilderInjection)            [Browser context]
  │     │   AIDomBuilder walks document.body recursively:
  │     │     - reads element._ariaRef.ref (set by captureSnapshot)
  │     │     - writes ref="e14" into output HTML string
  │     │     - skips <script>, <style>, event handlers, data-* attrs
  │     │     - filters CSS classes (strip generated, keep semantic)
  │     │     - sorts attributes in canonical order
  │     │     - crosses shadow DOM boundaries
  │     │     - collects iframe refs encountered
  │     │   returns { html: "<body>...", iframeRefs: ["f1e1"] }
  │     │                                                  [Back to Node.js]
  │     ├─ for each iframeRef:
  │     │     page.locator("aria-ref=f1e1").contentFrame()
  │     │     frame.evaluate(AIDomBuilderInjection)        [Child frame context]
  │     │     html.replace("<iframe ref='f1e1'>", stitched result)
  │     │
  │     └─ returns final HTML string (all iframes inlined)
  │
  ├─ 3. prettyPrintHtml(rawHtml)                           [Node.js]
  │     js-beautify html_beautify() with force-aligned attributes
  │     → deterministic, one-attr-per-line formatting for clean diffs
  │
  ├─ 4. diff.createPatch('dom.html', previousDom, dom)     [Node.js]
  │     Bundled diff v7 from playwright-core/lib/utilsBundle
  │     → unified diff string (or undefined if first snapshot)
  │
  ├─ 5. fs.writeFile()                                     [Node.js → disk]
  │     Write 2-3 files:
  │       .playwright-mcp/browser-state/dom.html           ← pretty-printed HTML
  │       .playwright-mcp/browser-state/a11y-tree.yaml     ← aria snapshot
  │       .playwright-mcp/browser-state/diffs/003-fill.diff ← unified diff
  │
  └─ 6. return { domPath, ariaPath, diffPath, diff }
        │
        Response._build() adds two text sections:
          "Browser State" → file paths (3 lines)
          (no inline diff — AI reads the file if it wants)
        │
        These append to the existing response text.
        No structural changes to CallToolResult.
```

### 8.2 New Dependency

Add `js-beautify` to the forked `playwright` package:

```json
// playwright/packages/playwright/package.json
"dependencies": {
  "playwright-core": "1.59.0-next",
  "js-beautify": "^1.15.0"
}
```

This is our fork — adding a dependency is fine. `js-beautify` is used server-side only (Node.js, not browser). The `diff` library is already bundled in `playwright-core/lib/utilsBundle`, so it needs no additional installation.

### 8.3 New Files to Create

All in the monorepo at `playwright/packages/playwright/src/mcp/browser/`.

#### `domState.ts` — Core Module

This is the main module. Responsibilities:
- Extract DOM via `page.evaluate()`
- Strip and pretty-print
- Inject `ref` attributes
- Compute unified diff
- Write files to workspace
- Generate response section

```typescript
import fs from 'fs';
import path from 'path';
import { diff } from 'playwright-core/lib/utilsBundle';
import { callOnPageNoTrace } from './tools/utils';
import { AIDomBuilderInjection } from './domExtractor';
import { prettyPrintHtml } from './domPrettyPrint';
import type { Page } from '../../../../playwright-core/src/client/page';
import type { Context } from './context';

// State persisted across tool calls (one per Context)
export class DomState {
  private _previousDom: string | undefined;
  private _diffCounter = 0;
  private _stateDir: string | undefined;

  constructor() {}

  // Called from Response._build() after captureSnapshot()
  async update(
    page: Page,
    context: Context,
    toolName: string,
    toolArgs: Record<string, any>,
    ariaSnapshot: string,  // the YAML string from captureSnapshot
  ): Promise<DomStateResult | undefined> {
    // 1. Resolve workspace directory — bail early if no workspace root.
    //    Don't run page.evaluate() if we have nowhere to write files.
    //    This avoids wasting time walking the DOM, serializing HTML,
    //    and transferring it over CDP for nothing.
    const stateDir = await this._ensureStateDir(context);
    if (!stateDir)
      return undefined;

    // 2. Extract DOM from browser.
    //    extractFullDom() runs AIDomBuilderInjection in main frame via page.evaluate(),
    //    then stitches iframe content. Returns one big HTML string.
    let rawHtml: string;
    try {
      rawHtml = await extractFullDom(page);
    } catch {
      return undefined;  // page navigated, closed, etc.
    }

    // 3. Pretty-print for clean diffs (js-beautify, force-aligned attributes)
    const dom = prettyPrintHtml(rawHtml);

    // 4. Compute diff against previous
    let diffStr: string | undefined;
    if (this._previousDom !== undefined) {
      const patch = diff.createPatch('dom.html', this._previousDom, dom, undefined, undefined, { context: 3 });
      // createPatch returns header even if no changes — check for actual hunks
      if (patch.includes('@@'))
        diffStr = patch;
    }

    // 5. Write files
    const domPath = path.join(stateDir, 'dom.html');
    const ariaPath = path.join(stateDir, 'accessibility-tree.yaml');
    await fs.promises.writeFile(domPath, dom, 'utf-8');
    await fs.promises.writeFile(ariaPath, ariaSnapshot, 'utf-8');

    // 6. Write diff file
    let diffPath: string | undefined;
    if (diffStr) {
      this._diffCounter++;
      const diffName = formatDiffName(this._diffCounter, toolName, toolArgs);
      diffPath = path.join(stateDir, 'diffs', diffName);
      await fs.promises.writeFile(diffPath, diffStr, 'utf-8');
    }

    // 7. Update state
    this._previousDom = dom;

    return { domPath, ariaPath, diffPath, diff: diffStr };
  }

  private async _ensureStateDir(context: Context): Promise<string | undefined> {
    if (this._stateDir)
      return this._stateDir;

    const instanceId = process.env.PW_DOM_STATE_INSTANCE_ID;
    const muxWorkspace = process.env.PW_DOM_STATE_WORKSPACE;

    if (instanceId && muxWorkspace) {
      // Multiplexer mode — per-instance directory.
      // The multiplexer sets these env vars at spawn time so each child
      // writes to its own subdirectory and they don't stomp each other.
      this._stateDir = path.join(muxWorkspace, '.playwright-mcp', 'browser-state', instanceId);
    } else if (context.hasExplicitRoots()) {
      // Standalone mode — single directory.
      // The AI client declared workspace roots, so we know where to write.
      this._stateDir = path.join(context.firstRootPath()!, '.playwright-mcp', 'browser-state');
    } else {
      // No workspace info at all — skip DOM state entirely.
      return undefined;
    }

    await fs.promises.mkdir(this._stateDir, { recursive: true });
    await fs.promises.mkdir(path.join(this._stateDir, 'diffs'), { recursive: true });
    return this._stateDir;
  }

  /** Clean up .playwright-mcp/browser-state/ on MCP instance shutdown. Called from Context.dispose(). */
  async dispose(): Promise<void> {
    if (this._stateDir) {
      await fs.promises.rm(this._stateDir, { recursive: true, force: true });
      this._stateDir = undefined;
    }
  }
}

/** Format diff filename: 001-navigate-example-com.diff */
function formatDiffName(counter: number, toolName: string, toolArgs: Record<string, any>): string {
  const num = String(counter).padStart(3, '0');
  const action = toolName.replace('browser_', '');
  const ref = toolArgs.ref ?? '';
  const value = typeof toolArgs.value === 'string' ? toolArgs.value.slice(0, 20) : '';
  const suffix = [ref, value].filter(Boolean).join('-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-');
  return `${num}-${action}${suffix ? '-' + suffix : ''}.diff`;
}

type DomStateResult = {
  domPath: string;
  ariaPath: string;
  diffPath: string | undefined;
  diff: string | undefined;
};
```

#### File Path Resolution

DOM state files live inside the existing `.playwright-mcp/` output directory — co-located with screenshots, downloads, and other Playwright MCP output. The AI already knows about this directory from other tool responses.

**Two modes — standalone vs multiplexer:**

```
# Standalone (single Playwright MCP instance)
my-project/
  .playwright-mcp/
    browser-state/
      dom.html
      accessibility-tree.yaml
      diffs/

# Multiplexer (multiple instances via playwright-mcp-multiplexer)
my-project/
  .playwright-mcp/
    browser-state/
      inst-1/                    ← instance 1's DOM state
        dom.html
        accessibility-tree.yaml
        diffs/
      inst-2/                    ← instance 2's DOM state
        dom.html
        accessibility-tree.yaml
        diffs/
```

**Path resolution — three-tier check:**

```
1. Check env vars (multiplexer mode):
   PW_DOM_STATE_INSTANCE_ID + PW_DOM_STATE_WORKSPACE set?
   → yes → <workspace>/.playwright-mcp/browser-state/<instanceId>/

2. Check MCP roots (standalone mode):
   context.hasExplicitRoots()?
   → yes → <rootPath>/.playwright-mcp/browser-state/

3. Neither available:
   → DOM state disabled — no extraction, no files
```

Note: `firstRootPath()` itself always returns a value (falls back to `process.cwd()` internally), but we gate on `hasExplicitRoots()` first. This prevents creating files in an unknown `cwd` that the AI can't find.

**Behavior by scenario:**

| Mode | How workspace is determined | DOM State Location |
|---|---|---|
| Standalone + Claude Code | `clientInfo.roots[0]` (project dir) | `<project>/.playwright-mcp/browser-state/` |
| Standalone + Cursor | `clientInfo.roots[0]` (workspace folder) | `<workspace>/.playwright-mcp/browser-state/` |
| Multiplexer | `PW_DOM_STATE_WORKSPACE` env var | `<workspace>/.playwright-mcp/browser-state/inst-1/` |
| No roots, no env vars | — | **DOM state disabled** |

**No fallback.** If neither env vars nor explicit roots are available, DOM state is silently skipped. The `_ensureStateDir()` check happens **before** any `page.evaluate()` calls, so we don't waste time extracting DOM we have nowhere to put.

**Multiplexer integration:**

The multiplexer (`playwright-mcp-multiplexer`) spawns child Playwright MCP instances as separate processes via `StdioClientTransport`. Children don't receive MCP roots from the multiplexer and don't know their own instance ID. We solve this with two env vars set at spawn time:

```typescript
// instance-manager.ts — multiplexer sets env vars when spawning children
const transport = new StdioClientTransport({
  command: 'node',
  args: [this.config.cliPath, ...args],
  env: {
    ...process.env,
    DEBUG: process.env.DEBUG ?? '',
    PW_DOM_STATE_INSTANCE_ID: id,              // "inst-1"
    PW_DOM_STATE_WORKSPACE: this.workspaceRoot, // AI client's workspace root
  },
});
```

The multiplexer gets `workspaceRoot` from the AI client during MCP initialization (the client sends `roots` in its `initialize` request). This is stored and passed to every child.

**Why env vars instead of protocol changes:**
- Set once at spawn time, not on every tool call — no forwarding overhead
- No changes to MCP protocol or tool call routing
- Clean separation: multiplexer handles orchestration, child handles extraction
- `DomState` is our code — checking env vars doesn't pollute upstream Playwright

**Response paths** are relative to the workspace root (via `Response._computRelativeTo()`):

```
# Standalone:
### Browser State
- DOM: .playwright-mcp/browser-state/dom.html

# Multiplexer (inst-1):
### Browser State
- DOM: .playwright-mcp/browser-state/inst-1/dom.html
```

The AI sees the instance ID in the path and can match it to the instance it's working with. `Read .playwright-mcp/browser-state/inst-1/dom.html` works from any AI client's file tools.

#### `domExtractor.ts` — AI DOM Builder (In-Page Serializer)

Instead of cloning the DOM and stripping the clone, we walk the DOM tree manually and build an HTML string directly — the same pattern Playwright uses for the aria tree builder (`generateAriaTree`). This solves every problem at once:

- **Shadow DOM**: We cross shadow root boundaries just like Playwright does
- **Ref stamping**: We read `_ariaRef` (assigned by `captureSnapshot()`) during the walk and stamp `ref` into the output HTML string — never modifying the live DOM
- **Noise stripping**: We skip unwanted elements/attributes during serialization
- **No `cloneNode`**: No parallel traversal hack, no live DOM modification
- **Iframe discovery**: Collects iframe refs during the walk, returned alongside the HTML for stitching

**Critical constraint: `page.evaluate()` serialization.** When you call `page.evaluate(fn)`, Playwright serializes the function as a string and sends it to the browser via CDP. The function must be **completely self-contained** — no imports, no module-scope references, no closures over external variables. Everything (the class, constants, helpers) must live inside the function body.

This is how Playwright's own injected scripts work — `generateAriaTree` and all its helpers are bundled into one self-contained injection. Our `AIDomBuilderInjection` follows the same pattern.

```typescript
// domExtractor.ts
//
// Exports a single self-contained function for page.evaluate().
// ALL classes, constants, and helpers are defined INSIDE the function body
// because page.evaluate() serializes the function as a string — it cannot
// reference anything outside its own scope.

export const AIDomBuilderInjection = (): { html: string, iframeRefs: string[] } => {

  // --- Constants (must be inside the function) ---

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const VOID_TAGS = new Set([
    'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR',
    'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR'
  ]);
  const SVG_NOISE_ATTRS = new Set(['d', 'points']);

  // Canonical attribute order for stable diffs.
  // Lower number = appears first. ref is handled separately (always last).
  const ATTR_ORDER: Record<string, number> = {
    'id': 0, 'type': 1, 'name': 2, 'role': 3,
    'href': 10, 'src': 11, 'action': 12, 'method': 13, 'for': 14,
    'value': 20, 'placeholder': 21, 'required': 22, 'disabled': 23, 'checked': 24,
    'selected': 25, 'multiple': 26, 'readonly': 27,
    'class': 40, 'alt': 41, 'title': 42, 'target': 43, 'rel': 44,
  };

  // Patterns that indicate a generated/framework CSS class
  const GENERATED_CLASS_PATTERNS = [
    /^(css|sc|emotion|styled|jsx)-/,   // CSS-in-JS framework prefixes
    /^_[a-zA-Z0-9]{5,}$/,              // CSS modules hashes: _3fkL2xB
    /[a-f0-9]{8,}/i,                   // contains long hex hash substring
  ];

  // --- Helper functions (must be inside the function) ---

  function shouldSkipAttribute(name: string): boolean {
    if (name.startsWith('on')) return true;       // event handlers
    if (name === 'style') return true;            // inline styles
    if (name.startsWith('data-')) return true;     // data-* attributes
    return false;
  }

  function attrOrder(name: string): number {
    if (name in ATTR_ORDER) return ATTR_ORDER[name];
    if (name.startsWith('aria-')) return 5;  // aria-* goes after role
    return 30;                                // everything else in the middle
  }

  function filterClasses(classStr: string): string {
    return classStr
      .split(/\s+/)
      .filter(cls => cls && !GENERATED_CLASS_PATTERNS.some(p => p.test(cls)))
      .join(' ');
  }

  function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- The builder class (must be inside the function) ---

  class AIDomBuilder {
    private _html: string[] = [];       // string buffer for performance
    private _iframeRefs: string[] = []; // iframe refs found during walk

    /** Entry point — returns serialized HTML + list of iframe refs found */
    build(root: Element): { html: string, iframeRefs: string[] } {
      this._html = [];
      this._iframeRefs = [];
      this._serializeElement(root);
      return { html: this._html.join(''), iframeRefs: this._iframeRefs };
    }

    /** Serialize one element: open tag → children → shadow → close tag */
    private _serializeElement(el: Element): void {
      if (this._shouldSkipElement(el)) return;

      const tag = el.tagName;
      const tagLower = tag.toLowerCase();

      // Collect iframe refs for stitching later
      if (tag === 'IFRAME') {
        const ref = (el as any)._ariaRef?.ref;
        if (ref) this._iframeRefs.push(ref);
      }

      // Opening tag
      this._html.push(`<${tagLower}`);
      this._serializeAttributes(el);
      this._serializeRef(el);
      this._html.push('>');

      // Void elements — no children, no closing tag
      if (VOID_TAGS.has(tag)) return;

      // Children (light DOM)
      this._serializeChildren(el);

      // Shadow DOM — cross the boundary, just like generateAriaTree does
      if (el.shadowRoot) {
        this._html.push('<!-- shadow-root -->');
        this._serializeChildren(el.shadowRoot);
        this._html.push('<!-- /shadow-root -->');
      }

      // Closing tag
      this._html.push(`</${tagLower}>`);
    }

    /** Iterate child nodes — dispatch text vs element */
    private _serializeChildren(parent: Element | ShadowRoot): void {
      for (let child = parent.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent || '';
          if (text.trim())
            this._html.push(escapeHtml(text));
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          this._serializeElement(child as Element);
        }
      }
    }

    /** Should this element be skipped entirely (including all children)? */
    private _shouldSkipElement(el: Element): boolean {
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag)) return true;
      if (tag === 'LINK' && el.getAttribute('rel') === 'stylesheet') return true;
      // Keep hidden elements — they may become visible (e.g., validation errors).
      // The AI can see them and anticipate state changes.
      return false;
    }

    /** Write filtered attributes in canonical order for stable diffs */
    private _serializeAttributes(el: Element): void {
      const attrs: [string, string][] = [];
      for (const attr of el.attributes) {
        if (shouldSkipAttribute(attr.name)) continue;
        if (attr.name === 'ref') continue; // skip existing ref attrs (Vue collision prevention)
        if (this._isSvgNoise(el, attr.name)) {
          attrs.push([attr.name, '...']);
          continue;
        }
        if (attr.name === 'class') {
          const filtered = filterClasses(attr.value);
          if (filtered)
            attrs.push(['class', filtered]);
          continue;
        }
        attrs.push([attr.name, attr.value]);
      }

      // Sort by canonical order — keeps diffs stable across snapshots
      attrs.sort((a, b) => attrOrder(a[0]) - attrOrder(b[0]));

      for (const [name, value] of attrs)
        this._html.push(` ${name}="${escapeAttr(value)}"`);
    }

    /**
     * Stamp ref into the HTML output string.
     * Reads _ariaRef (JS property assigned by captureSnapshot), never modifies live DOM.
     */
    private _serializeRef(el: Element): void {
      const ref = (el as any)._ariaRef?.ref;
      if (ref)
        this._html.push(` ref="${ref}"`);
    }

    /** Is this a noisy SVG attribute? */
    private _isSvgNoise(el: Element, attrName: string): boolean {
      return SVG_NOISE_ATTRS.has(attrName) &&
        (el.tagName === 'PATH' || el.tagName === 'POLYGON');
    }
  }

  // --- Execute ---
  return new AIDomBuilder().build(document.body);
};
```

#### Iframe Stitching

Iframes are separate documents with separate JS contexts. The `AIDomBuilder` is reusable — the same class runs in every frame. It returns `iframeRefs` listing the iframe refs it found during the walk. The stitcher in Node.js uses those refs to look up child frames via Playwright's `aria-ref` selector engine (which reads `_ariaRef` from the live DOM), runs the builder in each child frame, and inlines the result.

**In `domState.ts` (Node.js side):**

```typescript
async function extractFullDom(page: Page): Promise<string> {
  // 1. Run AIDomBuilder in main frame
  //    Returns the HTML string + list of iframe refs found during the walk
  const main = await callOnPageNoTrace(page, p => p.evaluate(AIDomBuilderInjection));
  let html = main.html;

  // 2. For each iframe ref the builder found, enter the frame and build
  for (const ref of main.iframeRefs) {
    try {
      // Look up the <iframe> element in the live DOM using its _ariaRef,
      // then enter the frame
      const frame = page.locator(`aria-ref=${ref}`).contentFrame();

      // Run the same AIDomBuilder inside the child frame
      const child = await frame.evaluate(AIDomBuilderInjection);

      // Stitch child HTML into the parent's <iframe> tag
      html = html.replace(
        `<iframe ref="${ref}"></iframe>`,
        `<iframe ref="${ref}">\n<!-- BEGIN IFRAME ${ref} -->\n${child.html}\n<!-- END IFRAME ${ref} -->\n</iframe>`
      );

      // Recurse: if the child frame had iframes too, stitch those
      // (handled by processing all frames — page.locator works for nested frames too)
      for (const childRef of child.iframeRefs) {
        const nestedFrame = frame.locator(`aria-ref=${childRef}`).contentFrame();
        const nested = await nestedFrame.evaluate(AIDomBuilderInjection);
        html = html.replace(
          `<iframe ref="${childRef}"></iframe>`,
          `<iframe ref="${childRef}">\n<!-- BEGIN IFRAME ${childRef} -->\n${nested.html}\n<!-- END IFRAME ${childRef} -->\n</iframe>`
        );
      }
    } catch {
      // Frame navigated, detached, or cross-origin — leave empty
    }
  }

  return html;
}
```

**Data flow:**

```
                    Node.js (domState.ts)                Browser (page context)
                    ────────────────────                ────────────────────────

1. page.evaluate(AIDomBuilderInjection) ──────────────► AIDomBuilder walks main frame DOM
                                                        reads _ariaRef (assigned by captureSnapshot)
                                                        stamps ref="e18" into HTML string
                                                        collects iframeRefs: ["f1e1"]
   main = { html: "...", iframeRefs: ["f1e1"] } ◄──── returns serialized data

2. page.locator("aria-ref=f1e1")  ────────────────────► looks up <iframe> by _ariaRef in live DOM
   .contentFrame()                ────────────────────► enters child frame

3. frame.evaluate(AIDomBuilderInjection) ─────────────► SAME AIDomBuilder walks child frame DOM
                                                        reads _ariaRef (also assigned by captureSnapshot)
   child = { html: "...", iframeRefs: [] }    ◄─────── returns child HTML

4. html.replace("<iframe ref='f1e1'>", ...)             stitches child HTML into parent string
```

**Result for a page with a Stripe payment iframe:**

```html
<form ref="e10">
  <input type="text" name="name" ref="e12">
  <iframe src="https://js.stripe.com/v3/elements" ref="f1e1">
    <!-- BEGIN IFRAME f1e1 -->
    <body>
      <input type="text" placeholder="Card number" ref="f1e2">
      <input type="text" placeholder="MM / YY" ref="f1e3">
      <input type="text" placeholder="CVC" ref="f1e4">
    </body>
    <!-- END IFRAME f1e1 -->
  </iframe>
  <button type="submit" ref="e30">Pay</button>
</form>
```

The AI can grep for `ref="f1e2"` and see it's a card number field inside the Stripe iframe, with the form context around it.

#### `domPrettyPrint.ts` — HTML Pretty-Printer

Server-side (Node.js) pretty-printer using [`js-beautify`](https://github.com/beautifier/js-beautify) — a battle-tested HTML formatter with exactly the attribute-wrapping modes we need for clean diffs.

**Why `js-beautify`:**
- `wrap_attributes: 'force-aligned'` — puts each attribute on its own line, aligned under the first attribute. This means when a `value` changes, only that one line shows up in the diff.
- Handles void elements, self-closing tags, inline text, and all HTML edge cases correctly.
- 50M+ weekly npm downloads, actively maintained, zero-dependency core.
- Used by VS Code, Prettier (as fallback), and most HTML formatting tools.

**Installation:** Add to the monorepo's Playwright package dependencies:
```bash
cd playwright/packages/playwright
npm install js-beautify
```

**Implementation:**

```typescript
import { html_beautify } from 'js-beautify';

const BEAUTIFY_OPTIONS = {
  indent_size: 2,
  indent_char: ' ',
  wrap_line_length: 120,
  wrap_attributes: 'force-aligned' as const,
  wrap_attributes_min_attrs: 3,       // wrap when 3+ attrs (keeps simple tags on one line)
  preserve_newlines: false,           // deterministic output — don't preserve original formatting
  max_preserve_newlines: 0,
  end_with_newline: true,
  indent_inner_html: true,
  unformatted: ['code', 'pre'],       // don't reformat these
  content_unformatted: ['pre', 'code', 'textarea'],
  void_elements: [                    // self-close these (no </input>, etc.)
    'area', 'base', 'br', 'col', 'embed', 'hr',
    'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'
  ],
};

/**
 * Pretty-print HTML for deterministic, diff-friendly output.
 *
 * Input:  raw HTML string from AIDomBuilder (compact, no formatting)
 * Output: indented HTML with one attribute per line for multi-attr elements
 *
 * Example output:
 *   <input id="first-name"
 *          type="text"
 *          name="firstName"
 *          required
 *          aria-required="true"
 *          value=""
 *          ref="e14">
 */
export function prettyPrintHtml(html: string): string {
  return html_beautify(html, BEAUTIFY_OPTIONS);
}
```

**What `force-aligned` does:**

```html
<!-- Input (compact, from AIDomBuilder): -->
<input id="first-name" type="text" name="firstName" required aria-required="true" value="" ref="e14">

<!-- Output (force-aligned, 3+ attrs triggers wrap): -->
<input id="first-name"
       type="text"
       name="firstName"
       required
       aria-required="true"
       value=""
       ref="e14">
```

Simple elements with 1-2 attributes stay on one line:
```html
<a href="/home" ref="e5">Home</a>
<button ref="e8">Sign Out</button>
```

This means after `browser_type` fills a field, the diff is exactly one line:
```diff
-       value=""
+       value="John"
```

#### ~~`domDiff.ts`~~ — NOT NEEDED

Playwright already bundles `diff` v7 in `playwright-core/lib/utilsBundle`. Use directly:

```typescript
import { diff } from 'playwright-core/lib/utilsBundle';

const patch = diff.createPatch('dom.html', previousHtml, currentHtml, undefined, undefined, { context: 3 });
```

### 8.4 Files to Modify

#### `browser/response.ts` — Add DOM State Section

The existing response format is **not changed** — the aria snapshot, error/result sections, tab headers, events, etc. all stay exactly the same. We only **append** one small section at the end:

1. **Browser State** — 3 short lines with file paths (always present when DOM state is active)

No inline diff in the response. The AI reads the diff file from disk if it wants to inspect what changed. This keeps the response lean — the AI controls its own token budget by choosing what to read.

The AI's primary in-context tool is still the aria tree. The Browser State section just says "these files exist on disk, read them if you need more context."

Add a `DomState` reference and call it during `_build()`.

**New import:**
```typescript
import type { DomState } from './domState';
```

**New constructor parameter or setter:**
```typescript
private _domState: DomState | undefined;

setDomState(domState: DomState) {
  this._domState = domState;
}
```

**New section in `_build()` — after Snapshot section, before Events:**

```typescript
// DOM State section
if (this._domState && tabSnapshot && this._includeSnapshot !== 'none') {
  const ariaSnapshotYaml = this._includeSnapshot === 'full'
    ? tabSnapshot.ariaSnapshot
    : tabSnapshot.ariaSnapshotDiff ?? tabSnapshot.ariaSnapshot;

  const result = await this._domState.update(
    this._context.currentTabOrDie().page,
    this._context,
    this.toolName,
    this.toolArgs,
    tabSnapshot.ariaSnapshot,  // always write the full aria tree to file
  );

  if (result) {
    const lines: string[] = [];
    lines.push(`- DOM: ${this._computRelativeTo(result.domPath)}`);
    lines.push(`- Accessibility tree: ${this._computRelativeTo(result.ariaPath)}`);
    if (result.diffPath)
      lines.push(`- Diff: ${this._computRelativeTo(result.diffPath)}`);
    addSection('Browser State', lines);
    // No inline diff — the AI reads the diff file if it wants to.
    // Keeps the response lean; the AI controls its own token budget.
  }
}
```

**Update `parseResponse()` to recognize new section:**
```typescript
const browserState = sections.get('Browser State');
// Add to return object
```

#### `browser/context.ts` — Own the DomState Instance

Add a `DomState` instance to `Context`, one per session. Clean up on dispose:

```typescript
import { DomState } from './domState';

export class Context {
  // ... existing fields ...
  readonly domState: DomState;

  constructor(options: ContextOptions) {
    // ... existing init ...
    this.domState = new DomState();
  }

  /** Did the MCP client declare workspace roots? */
  hasExplicitRoots(): boolean {
    return this._clientInfo.roots.length > 0;
  }

  async dispose() {
    // ... existing cleanup ...
    await this.domState.dispose();  // wipe .playwright-mcp/browser-state/ on shutdown
  }
}
```

#### `browser/browserServerBackend.ts` — Pass DomState to Response

In `callTool()`, pass the `DomState` to the `Response`:

```typescript
async callTool(name: string, rawArguments: ...) {
  // ... existing code ...
  const response = new Response(context, name, parsedArguments, cwd);
  response.setDomState(context.domState);  // <-- NEW
  // ... rest unchanged ...
}
```

### 8.5 File Summary

| File | Action | What |
|------|--------|------|
| `browser/domState.ts` | CREATE | Core orchestrator: runs `AIDomBuilderInjection` in each frame, stitches iframes via `aria-ref` selector + `contentFrame()`, diffs with `diff.createPatch()`, writes `.playwright-mcp/browser-state/` files |
| `browser/domExtractor.ts` | CREATE | `AIDomBuilder` class + `AIDomBuilderInjection` entry point: recursive DOM walker that serializes HTML, stamps refs from `_ariaRef`, strips noise, crosses shadow DOM, collects iframe refs — runs in browser via `page.evaluate()`, reusable across all frames |
| `browser/domPrettyPrint.ts` | CREATE | Thin wrapper around `js-beautify` (`html_beautify`) with `force-aligned` attribute wrapping for diff-friendly output |
| ~~`browser/domDiff.ts`~~ | NOT NEEDED | Use `diff.createPatch()` from `playwright-core/lib/utilsBundle` |
| `browser/response.ts` | MODIFY | Add Browser State section to `_build()` |
| `browser/context.ts` | MODIFY | Add `DomState` instance, call `domState.dispose()` in `dispose()` |
| `browser/browserServerBackend.ts` | MODIFY | Pass `DomState` to `Response` |
| `browser/tools/form.ts` | MODIFY | Add `response.setIncludeSnapshot()` so form fills produce DOM diffs |
| `package.json` | MODIFY | Add `js-beautify` dependency to `playwright/packages/playwright/` |
| **Multiplexer (separate package):** | | |
| `instance-manager.ts` | MODIFY | Pass `PW_DOM_STATE_INSTANCE_ID` and `PW_DOM_STATE_WORKSPACE` env vars when spawning children |

---

## 9. What the AI Sees After Each Action

### 9.1 After `browser_navigate`

```
### Page
- Page URL: https://workday.com/apply/12345
- Page Title: Apply: Software Engineer - Workday

### Snapshot
```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - link "Company Logo" [ref=e3]
    ...
  - main:
    - heading "Apply: Software Engineer" [level=1] [ref=e10]
    - textbox "First Name" [ref=e14]: ""
    - textbox "Email" [ref=e18]: ""
    - combobox "Country" [ref=e22]: "Select..."
    - button "Submit Application" [ref=e51]
  ...
```

### Browser State
- DOM: .playwright-mcp/browser-state/dom.html
- Accessibility tree: .playwright-mcp/browser-state/accessibility-tree.yaml
```

First navigation — no diff yet (no previous state). The AI has the aria tree in-context and can read `dom.html` if it needs more detail about any element.

### 9.2 After `browser_click` on the First Name field

```
### Snapshot
```yaml
- <changed> textbox "First Name" [active] [ref=e14]
```

### Browser State
- DOM: .playwright-mcp/browser-state/dom.html
- Accessibility tree: .playwright-mcp/browser-state/accessibility-tree.yaml
- Diff: .playwright-mcp/browser-state/diffs/002-click-e14.diff
```

The AI gets the aria tree in-context (compact) plus file paths. If it wants to see what changed in the DOM, it reads the diff file.

### 9.3 After `browser_fill_form` with multiple fields

```
### Browser State
- DOM: .playwright-mcp/browser-state/dom.html
- Accessibility tree: .playwright-mcp/browser-state/accessibility-tree.yaml
- Diff: .playwright-mcp/browser-state/diffs/003-fill-form.diff
```

The AI can `Read .playwright-mcp/browser-state/diffs/003-fill-form.diff` to see which fields changed values, or `Grep "ref=\"e14\"" .playwright-mcp/browser-state/dom.html -C 5` to check the context around a specific field.

---

## 10. The Agent's Workflow

```
1. Agent calls browser_navigate("https://workday.com/apply/12345")
   → Gets: aria tree in context + dom.html on disk

2. Agent reads aria tree (in context, ~2KB) — understands page structure, gets refs

3. Agent wants to know what help text is near the email field:
   → Grep "ref=\"e18\"" .playwright-mcp/browser-state/dom.html -C 5
   → Sees: label, input, help text, error container

4. Agent calls browser_fill_form([{ref:"e14", value:"John", ...}, ...])
   → Gets: inline diff showing value changes

5. Agent sees validation error in diff (aria-invalid appeared, error span added)
   → Knows exactly which field failed without re-reading the page

6. Agent fixes the field, continues filling

7. Agent needs to check what happened 3 actions ago:
   → Read .playwright-mcp/browser-state/diffs/003-fill-form.diff
```

---

## 11. Performance Considerations

| Operation | Where | Cost |
|-----------|-------|------|
| AIDomBuilder walk + serialize | `page.evaluate()` | ~10-30ms (DOM traversal + string building) |
| Transfer HTML string to Node.js | CDP protocol | ~5-20ms depending on page size |
| Pretty-print HTML | Node.js | ~10-50ms (string processing) |
| Compute unified diff | Node.js | ~5-20ms (line-based diff) |
| Write 3 files | fs.writeFile | ~1-5ms (async) |
| **Total overhead per tool call** | | **~35-130ms** |

Compare: `waitForCompletion()` takes 500-10500ms. The DOM extraction adds 3-15% overhead.

**When to skip:** If the tool doesn't include a snapshot (`_includeSnapshot === 'none'`), we skip DOM extraction. Note: `browser_fill_form` will be modified to call `response.setIncludeSnapshot()` so that form fills produce DOM diffs (see resolved Q1).

**File size:** A complex ATS page DOM, after stripping, is typically 15-50KB. Diffs are typically 200 bytes - 5KB. The `.playwright-mcp/browser-state/` directory for a full application flow (navigate + fill 3 pages) would be ~200KB total.

---

## 12. Resolved Design Questions

All questions have been resolved. Decisions are documented here for reference.

1. **Should `browser_fill_form` trigger DOM extraction?** RESOLVED: **Yes.** Add `response.setIncludeSnapshot()` to `browser_fill_form` so the agent gets both the aria diff and the DOM diff after filling fields. This is a one-line change in `form.ts`. Form fills are the most valuable actions to diff — the AI sees exactly which fields changed values.

2. **Class attribute filtering.** RESOLVED: **Strip generated classes, keep semantic ones.** The `AIDomBuilder` filters individual class tokens using regex patterns that match CSS-in-JS prefixes (`css-`, `sc-`, `emotion-`, `styled-`, `jsx-`), CSS modules hashes (`_3fkL2xB`), and strings containing long hex hashes. Everything else is kept — `help-text`, `error-message`, `form-group`, `is-invalid`, `btn-primary`, etc. If all tokens are stripped, the `class` attribute is omitted entirely. See `filterClasses()` and `isGeneratedClass()` in `domExtractor.ts`.

3. **Hidden elements.** RESOLVED: **Keep them.** Elements with `display:none` or `aria-hidden="true"` are kept in `dom.html`. They may become visible later (e.g., validation error messages that appear on submit, dropdown menus that open on click). Keeping them lets the AI anticipate state changes and understand the full page structure.

4. **Shadow DOM.** RESOLVED: **Handled by design.** The `AIDomBuilder` crosses shadow root boundaries during its walk, producing `<!-- shadow-root -->` / `<!-- /shadow-root -->` comment markers in the output. This mirrors how Playwright's `generateAriaTree` traverses shadow roots (ariaSnapshot.ts:163-166). No `cloneNode` involved — the custom serializer walks `el.shadowRoot` children directly.

5. **iframe content.** RESOLVED: **Inline from day one.** The `AIDomBuilder` collects iframe refs during its walk. The stitcher in Node.js uses `page.locator('aria-ref=ref').contentFrame()` to enter each child frame, runs the same `AIDomBuilderInjection` inside, and inlines the result with `<!-- BEGIN IFRAME f1e1 -->` / `<!-- END IFRAME f1e1 -->` comment markers.

6. **Diff library.** RESOLVED: **Use bundled `diff` v7.** `playwright-core/lib/utilsBundle` already bundles it. `diff.createPatch()` produces unified diffs. No custom implementation needed.

7. **Cleanup.** RESOLVED: **Wipe `.playwright-mcp/browser-state/` when the MCP instance dies.** Diffs accumulate during the session (they're a useful trail for the AI to look back at). On MCP server shutdown / `Context.dispose()`, the entire `.playwright-mcp/browser-state/` directory is deleted. This prevents stale state from leaking across sessions.

8. **Capability gating.** RESOLVED: **Always on.** DOM state extraction runs for every tool call that includes a snapshot. No feature flag needed. The overhead is minimal (~35-130ms, 3-15% of total tool call time), the file writes are cheap, and the response sections are small. Maximum AI intelligibility by default — the AI always has full DOM context available on disk.

---

## 13. Build & Test

```
Edit:   playwright/packages/playwright/src/mcp/browser/domState.ts
Build:  cd playwright && node utils/build/build.js
Test:   cd playwright-mcp/packages/playwright-mcp && npx playwright test --project=chrome
```

### Test Cases

1. **Navigate to page** → verify `dom.html` and `accessibility-tree.yaml` are written
2. **Click a field** → verify diff is written to `diffs/`, diff shows focus change
3. **Fill a field** → verify diff shows value change
4. **Fill form** → verify diff shows multiple value changes
5. **Ref injection** → verify `ref` attributes in `dom.html` match aria tree refs
6. **Stripping** → verify no `<script>`, `<style>`, inline handlers in `dom.html`
7. **Pretty-printing** → verify consistent formatting, one attribute per line for complex elements
8. **Grep cross-reference** → grep for a ref in `dom.html`, verify surrounding context is useful
9. **Diff trail** → perform 5 actions, verify 5 diff files in order
10. **Large page** → verify performance stays under 200ms overhead
11. **Iframe stitching** → page with iframe, verify child frame DOM is inlined with `<!-- BEGIN IFRAME -->` markers
12. **Iframe refs** → verify iframe element refs (`f1e1`, `f1e2`) appear correctly in `dom.html`
13. **Class filtering** → element with `class="css-1a2b3c help-text sc-dkPtRN"` → only `class="help-text"` in output
14. **Class filtering (all stripped)** → element with only generated classes → no `class` attribute in output
15. **Hidden elements** → `display:none` element is kept in `dom.html` (not stripped)
16. **Shadow DOM** → web component with shadow root → `<!-- shadow-root -->` markers in output, children serialized
17. **Cleanup on shutdown** → after MCP instance dispose, `.playwright-mcp/browser-state/` directory is deleted
18. **Fill form triggers DOM** → `browser_fill_form` produces DOM diff showing value changes
19. **Multiplexer: per-instance isolation** → two instances write to separate `inst-1/` and `inst-2/` directories, no cross-contamination
20. **Multiplexer: env vars** → child process receives `PW_DOM_STATE_INSTANCE_ID` and `PW_DOM_STATE_WORKSPACE`, creates correct directory
21. **Multiplexer: no env vars, no roots** → DOM state silently disabled, no errors, no files
22. **Multiplexer: response paths** → response includes `inst-1/` in file paths, AI can read them

---

## 14. Follow-Up: Agent Instructions Update

The DOM state files are only useful if the AI agent **knows they exist and how to use them**. This requires updating the agent's system prompt / instructions (the submitter or internet agent that drives the browser).

**What the agent needs to know:**

1. **After every browser action**, the response includes a "Browser State" section with file paths to `dom.html`, `accessibility-tree.yaml`, and a diff file.
2. **`dom.html`** contains the full page DOM, stripped of noise, with `ref="eN"` attributes matching the aria tree. Use `Read` to see the full page, or `Grep` with a ref to see context around a specific element.
3. **`accessibility-tree.yaml`** is the aria snapshot (same as in-context, but also on disk for reference).
4. **`diffs/NNN-action.diff`** shows what changed after each action. Use `Read` to inspect.
5. **When confused about a field** — grep for its ref in `dom.html` to see surrounding context (help text, labels, error messages, form structure).
6. **When debugging validation errors** — read the diff to see what attributes changed (`aria-invalid`, new error spans, etc.).
7. **For multiplexer** — files are per-instance under `.playwright-mcp/browser-state/<instanceId>/`.

**Ticket:** Update the submitter/internet agent's system prompt to include instructions about DOM state files — where they are, when to use `Read` vs `Grep`, and how refs cross-reference between the aria tree and `dom.html`.
