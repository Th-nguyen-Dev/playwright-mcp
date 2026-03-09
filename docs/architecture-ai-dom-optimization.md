# Architectural Report: AI-Optimized DOM State and Index-Based Interaction for concurrent-browser-mcp

**Date:** 2026-02-11
**Author:** Technical Architecture Review
**Status:** Research Complete -- Ready for Ticket Decomposition

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [browser-use DOM Approach Analysis](#2-browser-use-dom-approach-analysis)
3. [Design for AI-Optimized State](#3-design-for-ai-optimized-state)
4. [Index-Based Interaction Design](#4-index-based-interaction-design)
5. [Implementation Approach](#5-implementation-approach)
6. [Token Efficiency Analysis](#6-token-efficiency-analysis)
7. [Risk Assessment and Open Questions](#7-risk-assessment-and-open-questions)

---

## 1. Current State Analysis

### 1.1 Architecture Overview

concurrent-browser-mcp is a TypeScript MCP server built on Playwright. Its architecture consists of five files:

| File | Role |
|------|------|
| `src/server.ts` | MCP server setup, request routing via `@modelcontextprotocol/sdk` |
| `src/browser-manager.ts` | Browser instance lifecycle (create, get, close, cleanup timer) |
| `src/tools.ts` | Tool definitions (JSON schemas) and implementations (BrowserTools class) |
| `src/types.ts` | TypeScript interfaces for config, options, results |
| `src/index.ts` | CLI entry point via Commander |

The server manages multiple concurrent browser instances via a `Map<string, BrowserInstance>` keyed by UUID. Each instance holds a Playwright `Browser`, `BrowserContext`, and `Page`.

### 1.2 How Page Info Works Today

The `browser_get_page_info` tool (lines 791-843 of `tools.ts`) calls:

```typescript
const content = await instance.page.content();
```

This returns the **complete raw HTML** of the page as a string. The tool also gathers some basic statistics (link count, image count, form count, script count, stylesheet count) via `page.evaluate()`, but these stats are cosmetic metadata -- the actual page content returned to the LLM is the full `page.content()` dump.

### 1.3 Existing Tools and Their Selector Model

Every interaction tool requires a **CSS selector string** as the targeting mechanism:

| Tool | Targeting | Purpose |
|------|-----------|---------|
| `browser_click` | `selector: string` (required) | Click an element |
| `browser_type` | `selector: string` (required) | Type into an element |
| `browser_fill` | `selector: string` (required) | Fill a form field |
| `browser_select_option` | `selector: string` (required) | Select a dropdown option |
| `browser_get_element_text` | `selector: string` (required) | Read element text |
| `browser_get_element_attribute` | `selector: string` (required) | Read element attribute |
| `browser_wait_for_element` | `selector: string` (required) | Wait for element presence |
| `browser_screenshot` | `selector?: string` (optional) | Capture element screenshot |

All these tools pass the selector directly to Playwright APIs (`page.click(selector)`, `page.fill(selector, value)`, etc.).

### 1.4 The `browser_get_markdown` Tool

There is a `browser_get_markdown` tool (lines 1001-1189 of `tools.ts`) that converts page HTML to markdown via an in-page `page.evaluate()` call. It strips `<script>`, `<style>`, `<nav>`, `<footer>`, and `<aside>` elements, and converts headings, paragraphs, links, lists, tables, etc. to markdown syntax. It has a configurable `maxLength` (default 10,000 characters).

While this is more LLM-friendly than raw HTML, it has critical limitations for automation:
- It discards all interactive element identity (no IDs, no selectors, no indices)
- It is a read-only content view -- there is no path from "I see text X" to "interact with element Y"
- It does not distinguish between interactive and non-interactive elements

### 1.5 Limitations for AI Agent Use

The current architecture has five fundamental problems for AI-driven automation:

**Problem 1: Token waste.** A typical job application page (e.g., Greenhouse, Workday, Lever) has 50,000-200,000 characters of raw HTML. At ~4 characters per token, that is 12,500-50,000 tokens per page view -- often exceeding context window limits entirely.

**Problem 2: Selector crafting burden.** The LLM must analyze raw HTML, identify the target element, and synthesize a CSS selector. This is a multi-step reasoning task that LLMs frequently get wrong, especially for:
- Dynamically generated class names (React, Vue, Angular)
- Deeply nested elements in shadow DOM
- Elements distinguished only by position (nth-child)
- iframes with separate DOM trees

**Problem 3: No concept of interactivity.** The raw HTML dump treats every element equally. The LLM must determine which elements are interactive (inputs, buttons, links, selects) by parsing HTML semantics -- a task that requires deep DOM knowledge.

**Problem 4: Noise from non-content elements.** Raw HTML includes ad trackers, analytics scripts, SVG paths, CSS-in-JS, base64 images, and other artifacts that provide zero value for automation but consume massive token budgets.

**Problem 5: No page structure context.** There is no information about scroll position, viewport bounds, which elements are visible vs off-screen, or what the overall page layout looks like.

---

## 2. browser-use DOM Approach Analysis

### 2.1 Architecture Overview

browser-use takes a fundamentally different approach. Instead of returning raw HTML and requiring the LLM to craft selectors, it:

1. **Builds an Enhanced DOM Tree** from three CDP data sources simultaneously
2. **Filters to interactive/meaningful elements** using a multi-signal heuristic
3. **Serializes a compact LLM representation** with numbered indices
4. **Maps indices to backend node IDs** for direct CDP interaction

### 2.2 The Three-Source DOM Construction

browser-use's `DomService.get_dom_tree()` (in `dom/service.py`) makes three parallel CDP calls:

```
1. DOMSnapshot.captureSnapshot()  -- Layout, bounds, computed styles, paint order
2. DOM.getDocument(depth=-1, pierce=True)  -- Full DOM tree with shadow DOM piercing
3. Accessibility.getFullAXTree()  -- Accessibility tree with roles, names, properties
```

These three sources are merged into `EnhancedDOMTreeNode` objects. Each node contains:

- **DOM data:** nodeId, backendNodeId, nodeType, nodeName, nodeValue, attributes, children, shadow roots, content documents (iframes)
- **Accessibility data:** AX role, name, description, properties (checked, selected, expanded, pressed, disabled, required, etc.)
- **Snapshot data:** bounding box, client rects, scroll rects, computed styles, paint order, cursor style, isClickable flag

This is the key architectural insight: **no single CDP API provides all the information needed to determine interactivity reliably**. The snapshot gives layout/visibility, the DOM tree gives structure/attributes, and the AX tree gives semantic roles and states.

### 2.3 Interactivity Detection

The `ClickableElementDetector.is_interactive()` method (in `dom/serializer/clickable_elements.py`) uses a priority-ordered heuristic chain:

1. **JavaScript event listeners** -- CDP `getEventListeners()` detects click/mouse handlers on elements (handles React onClick, Vue @click, Angular (click), etc.)
2. **Interactive HTML tags** -- `button`, `input`, `select`, `textarea`, `a`, `details`, `summary`, `option`, `optgroup`
3. **ARIA roles** -- `button`, `link`, `menuitem`, `checkbox`, `radio`, `tab`, `textbox`, `combobox`, `slider`, `spinbutton`, `search`, `searchbox`, `row`, `cell`, `gridcell`
4. **AX tree properties** -- `focusable`, `editable`, `settable`, `checked`, `expanded`, `pressed`, `selected`, `required`, `autocomplete`, `keyshortcuts`
5. **Interactive HTML attributes** -- `onclick`, `onmousedown`, `tabindex`
6. **Cursor style** -- `cursor: pointer` from computed styles
7. **Label/span wrapping** -- Detects labels and spans that wrap form controls (Ant Design pattern)
8. **Search element heuristics** -- Class/ID patterns like `search`, `magnify`, `search-btn`
9. **Icon detection** -- Small elements (10-50px) with interactive attributes

There is also negative detection:
- `aria-disabled=true` -> not interactive
- `aria-hidden=true` -> not interactive
- `<html>` and `<body>` -> not interactive

### 2.4 Serialization Pipeline

The `DOMTreeSerializer` (in `dom/serializer/serializer.py`) transforms the enhanced DOM tree through four stages:

**Stage 1: Simplified Tree** -- Filters out non-content elements (`script`, `style`, `head`, `meta`, `link`, `title`, SVG children), processes shadow DOM, handles iframes via content documents, and preserves visibility/scrollability information.

**Stage 2: Paint Order Filtering** -- Removes elements occluded by other elements based on paint order and stacking contexts (prevents indexing elements hidden behind overlays/modals).

**Stage 3: Tree Optimization** -- Removes unnecessary parent wrapper nodes that add indentation without adding information.

**Stage 4: Bounding Box Filtering** -- Removes child elements that are fully contained within interactive parent bounds (e.g., `<span>` inside `<button>`) to avoid double-indexing.

**Stage 5: Index Assignment** -- Assigns `backend_node_id` as the index for each interactive element and builds the `selector_map: Dict[int, EnhancedDOMTreeNode]`.

### 2.5 LLM Representation Format

The final output looks like this:

```
url: https://boards.greenhouse.io/company/jobs/12345
title: Job Application
scroll: y=0, viewport=720px, 0px above, 1200px below

[42]<input type=text value=Sebastian placeholder=First name />
[43]<input type=text placeholder=Last name />
[44]<input type=email placeholder=Email required />
[45]<input type=tel placeholder=Phone />
Resume / CV
[46]<input type=file accept=.pdf,.doc,.docx compound_components=(role=button,name=Browse Files),(role=textbox,name=File Selected,current=None) />
[47]<select name=source value=LinkedIn compound_components=(role=button,name=Dropdown Toggle),(role=listbox,name=Options,count=5,options=LinkedIn|Indeed|Company Website|Referral|... 1 more options...) />
Submit Application
[48]<button />
```

Key characteristics of this format:
- **Hierarchical indentation** preserves page structure context
- **Interactive elements** are prefixed with `[backendNodeId]` -- this is the index
- **Non-interactive text** appears inline without indices (headings, labels, paragraphs)
- **Attributes** include only the subset relevant for automation (type, value, placeholder, role, checked, required, etc.)
- **Scroll context** appears at the top and on scrollable containers
- **Compound controls** (file inputs, selects) include component details

### 2.6 How Index-Based Interaction Works

When the LLM calls `browser_click(index=42)`:

1. `BrowserSession.get_dom_element_by_index(42)` looks up `backend_node_id=42` in the cached `selector_map`
2. The returned `EnhancedDOMTreeNode` contains the `backend_node_id`, `target_id`, and `session_id`
3. The click action dispatches a `ClickElementEvent(node=element)` through the event bus
4. The event handler uses CDP `DOM.resolveNode(backendNodeId)` to get a remote object reference
5. The remote object is used for interaction (click coordinates, typing, etc.)

The critical insight: **backend_node_id is stable within a page session** (it persists across DOM mutations until the page navigates). This means the index from `browser_get_state` remains valid for subsequent interactions without re-querying.

### 2.7 What browser-use Gets Right

- Token efficiency: A typical page produces 500-2,000 tokens instead of 12,500-50,000
- Zero selector crafting: The LLM just references a number
- Rich attributes: type, value, placeholder, checked, required, expanded, etc.
- Structural context: Indentation shows form groupings, sections, nested components
- Scroll awareness: Agent knows how much content is above/below viewport
- Compound control awareness: File inputs show current selection state, selects show available options
- Shadow DOM support: Pierces shadow roots and indexes elements inside them
- Iframe support: Recursively processes iframe content documents

### 2.8 What browser-use Gets Wrong (or Over-Engineers)

- **LLM dependency for content extraction:** `browser_extract_content` requires an OpenAI API key
- **CDP direct dependency:** Uses raw CDP protocol instead of Playwright's higher-level APIs
- **Single-session model:** One browser session at a time, no concurrent instances
- **Complexity:** The DOM service is ~1,000 lines; the serializer is ~1,300 lines; the clickable detector is ~250 lines -- approximately 2,500 lines of DOM processing code
- **Event bus architecture:** Heavy abstraction for click/type/scroll operations that adds indirection without clear benefit for our use case

---

## 3. Design for AI-Optimized State

### 3.1 Proposed New Tool: `browser_get_state`

Add a new tool that returns a curated, token-efficient representation of the current page state with indexed interactive elements.

**Tool Schema:**

```typescript
{
  name: 'browser_get_state',
  description: 'Get the current page state with all interactive elements indexed. '
    + 'Returns a compact DOM tree where interactive elements are marked with [index] numbers. '
    + 'Use these index numbers with browser_click, browser_type, browser_fill, browser_select_option. '
    + 'Includes element attributes (type, value, placeholder, role, checked, required) '
    + 'and page context (scroll position, viewport size).',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Instance ID' },
      fullPage: {
        type: 'boolean',
        description: 'Include elements beyond the viewport (default: true)',
        default: true
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum DOM depth to traverse (default: 50)',
        default: 50
      }
    },
    required: ['instanceId']
  }
}
```

### 3.2 Element Map Architecture

Each browser instance will maintain an `ElementMap` -- a bidirectional mapping between index numbers and element locator information.

```typescript
interface IndexedElement {
  index: number;
  tagName: string;
  attributes: Record<string, string>;   // Curated subset
  role?: string;                        // ARIA role
  text?: string;                        // Visible text content (truncated)
  selector: string;                     // Generated CSS selector for Playwright
  boundingBox?: { x: number; y: number; width: number; height: number };
  isVisible: boolean;
  isInViewport: boolean;
  iframeSelector?: string;              // If inside an iframe, the iframe's selector
  shadowHostSelector?: string;          // If inside shadow DOM, the host's selector
}

interface ElementMap {
  elements: Map<number, IndexedElement>;
  timestamp: number;                    // When the map was built
  url: string;                          // Page URL when built
  scrollPosition: { x: number; y: number };
  viewportSize: { width: number; height: number };
  pageHeight: number;
}
```

The `ElementMap` is stored on the `BrowserInstance` and rebuilt each time `browser_get_state` is called.

### 3.3 Interactive Element Extraction

Elements are classified as interactive if they match any of these criteria (checked in order):

**Tier 1: Inherently interactive HTML elements**
- `<input>` (all types)
- `<button>`
- `<select>`
- `<textarea>`
- `<a>` (with href)
- `<details>` / `<summary>`

**Tier 2: ARIA interactive roles**
- `role="button"`, `role="link"`, `role="menuitem"`, `role="checkbox"`, `role="radio"`, `role="tab"`, `role="textbox"`, `role="combobox"`, `role="slider"`, `role="spinbutton"`, `role="option"`, `role="searchbox"`

**Tier 3: Interactive attributes**
- `onclick`, `onmousedown`, `onkeydown`, `tabindex` (not -1)
- `contenteditable="true"`

**Tier 4: Cursor-based detection** (requires computed style check)
- Elements with `cursor: pointer` that do not match tiers 1-3

### 3.4 Attribute Curation

For each interactive element, include only automation-relevant attributes:

```typescript
const INCLUDE_ATTRIBUTES = [
  'type', 'name', 'id', 'value', 'placeholder',
  'role', 'aria-label', 'aria-expanded', 'aria-checked', 'aria-selected',
  'checked', 'selected', 'disabled', 'required', 'readonly',
  'min', 'max', 'minlength', 'maxlength', 'pattern',
  'accept', 'multiple',
  'href', 'target',
  'for',                    // label association
  'autocomplete',
  'contenteditable',
];
```

Excluded: `class`, `style`, `data-*` (except specific patterns), `on*` event handlers (their presence is noted by interactivity detection, but the handler code is noise).

### 3.5 Output Format

The output format should closely match browser-use's proven format, with adaptations:

```
url: https://boards.greenhouse.io/company/jobs/12345
title: Job Application - Company
viewport: 1280x720
scroll: y=0, page_height=2400

--- Interactive Elements ---

Personal Information
  [1]<input type=text name=first_name placeholder="First name" required />
  [2]<input type=text name=last_name placeholder="Last name" required />
  [3]<input type=email name=email placeholder="Email address" required />
  [4]<input type=tel name=phone placeholder="Phone number" />

Resume
  [5]<input type=file name=resume accept=".pdf,.doc,.docx" />

How did you hear about us?
  [6]<select name=source>
       <option>LinkedIn</option>
       <option>Indeed</option>
       <option>Company Website</option>
       <option>Referral</option>
     </select>

  [7]<textarea name=cover_letter placeholder="Cover letter (optional)" />

  [8]<button>Submit Application</button>

--- Page Links ---
  [9]<a href="/privacy">Privacy Policy</a>
  [10]<a href="/terms">Terms of Service</a>
```

Design decisions for the format:
- **Header block** with URL, title, viewport, scroll position
- **Structural text** (headings, labels, paragraphs) rendered inline without indices as context
- **Interactive elements** prefixed with `[N]` and rendered as self-closing HTML-like tags with curated attributes
- **Select options** rendered inline (first 5, with count if more)
- **Links section** separated at the bottom to reduce noise in form-heavy pages
- **Indentation** reflects DOM hierarchy for grouping context

### 3.6 Handling iframes

For same-origin iframes:
1. Use `frame.content()` or `page.frame()` / `page.frames()` to access iframe content
2. Traverse the iframe DOM using the same extraction logic
3. Prefix iframe elements in the output: `[IFRAME: src="..."]` section header
4. Store `iframeSelector` on each `IndexedElement` so interaction tools can call `page.frameLocator(iframeSelector)` before acting

For cross-origin iframes:
- Playwright cannot access cross-origin iframe DOM directly via `page.evaluate()`
- Option A: Use CDP `Target.attachToTarget()` for the iframe's target (complex, follows browser-use pattern)
- Option B: Skip cross-origin iframes and note their presence in the output (pragmatic)
- **Recommendation:** Start with Option B, add Option A later if needed for specific ATS platforms

### 3.7 Handling Shadow DOM

Playwright's CSS selectors support shadow DOM piercing natively: the `>>` combinator pierces shadow boundaries. For example: `#host >> input[type=text]`.

For element extraction:
1. Use `page.evaluate()` with recursive shadow root traversal
2. Use `element.shadowRoot.querySelectorAll('*')` inside the evaluate script
3. For each shadow DOM element, record the chain of shadow host selectors needed to reach it

For interaction, Playwright's `page.locator()` with `>>` syntax handles shadow DOM transparently, so stored selectors like `#host >> .inner-input` work directly.

---

## 4. Index-Based Interaction Design

### 4.1 Dual-Mode Tool Signatures

All interaction tools should support BOTH CSS selectors (backward compatibility) AND index-based targeting. The index takes precedence when both are provided.

**Modified `browser_click` schema:**

```typescript
{
  name: 'browser_click',
  description: 'Click on a page element. Use index (from browser_get_state) OR selector.',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Instance ID' },
      index: {
        type: 'number',
        description: 'Element index from browser_get_state (preferred)'
      },
      selector: {
        type: 'string',
        description: 'CSS selector (fallback if index not available)'
      },
      button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      clickCount: { type: 'number', default: 1 },
      timeout: { type: 'number', default: 30000 }
    },
    required: ['instanceId']
    // Note: at least one of index or selector must be provided (validated at runtime)
  }
}
```

**Modified `browser_type` schema:**

```typescript
{
  name: 'browser_type',
  description: 'Type text into an element. Use index (from browser_get_state) OR selector.',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Instance ID' },
      index: { type: 'number', description: 'Element index from browser_get_state (preferred)' },
      selector: { type: 'string', description: 'CSS selector (fallback)' },
      text: { type: 'string', description: 'Text to type' },
      delay: { type: 'number', default: 0 },
      timeout: { type: 'number', default: 30000 }
    },
    required: ['instanceId', 'text']
  }
}
```

The same pattern applies to `browser_fill`, `browser_select_option`, `browser_get_element_text`, `browser_get_element_attribute`, and `browser_wait_for_element`.

### 4.2 Index Resolution

When a tool receives an `index` parameter, the resolution flow is:

```
1. Get the BrowserInstance for instanceId
2. Check if instance has an ElementMap (built by browser_get_state)
3. Look up index in ElementMap.elements
4. If found, get the IndexedElement
5. If element is in an iframe:
   a. Use page.frameLocator(iframeSelector) to get the frame context
   b. Use frame.locator(selector) for the element within the frame
6. If element is in shadow DOM:
   a. Use page.locator(shadowHostSelector + ' >> ' + selector)
7. Otherwise:
   a. Use page.locator(selector) directly
8. Perform the requested action on the resolved locator
```

If the `ElementMap` is stale (page has navigated since last `browser_get_state`), the tool should return an error suggesting the agent call `browser_get_state` again.

### 4.3 Selector Generation Strategy

For each indexed element, we need to generate a reliable CSS selector. This is done during element map construction via injected JavaScript:

**Priority order for selector generation:**

1. `#id` -- If the element has a unique ID
2. `[name="value"]` -- If the element has a unique name attribute
3. `[data-testid="value"]` -- Testing attributes
4. `tag[type="value"][placeholder="value"]` -- Combination of stable attributes
5. `tag:nth-of-type(n)` within a scoped parent -- Positional fallback

The selector should be validated immediately after generation using `page.locator(selector).count()` to ensure it resolves to exactly one element.

### 4.4 Stale Element Map Detection

The `ElementMap` has a `url` and `timestamp`. Before using an index:

1. Check if `instance.page.url()` matches `elementMap.url` (basic navigation detection)
2. If URLs differ, return error: `"Element map is stale (page navigated). Call browser_get_state to refresh."`
3. If the element interaction fails (element detached, not found), return error suggesting refresh

This is simpler than browser-use's approach of rebuilding the DOM on every action, and avoids the performance penalty of full DOM extraction on every click.

---

## 5. Implementation Approach

### 5.1 Three Candidate Approaches

There are three fundamental approaches to extracting the interactive element tree. Each has distinct trade-offs.

#### Approach A: Playwright JavaScript Injection (Recommended)

**Mechanism:** Use `page.evaluate()` to run a JavaScript function in the page context that walks the DOM, identifies interactive elements, collects attributes, generates selectors, computes bounding boxes, and returns a serialized element list.

**Advantages:**
- Zero additional dependencies beyond Playwright
- Access to `window.getComputedStyle()` for cursor/display/visibility checks
- Access to `element.getBoundingClientRect()` for accurate viewport-relative positions
- Native shadow DOM traversal via `element.shadowRoot`
- Works with all three browser engines (Chromium, Firefox, WebKit)
- Single round-trip: one `page.evaluate()` call extracts everything
- Can be tested in any browser's DevTools console

**Disadvantages:**
- No access to Accessibility Tree (must use HTML semantics + ARIA attributes only)
- No paint order information (cannot detect elements hidden behind overlays)
- Cross-origin iframe content is inaccessible from the parent page's JS context
- Must handle `document.querySelectorAll('*')` performance on large DOMs (~50-100ms for 10K elements)

**Complexity estimate:** ~400-600 lines of TypeScript (the injected JS function + the TypeScript wrapper/serializer)

#### Approach B: Playwright Accessibility Tree API

**Mechanism:** Use `page.accessibility.snapshot()` to get Playwright's built-in accessibility tree, which contains roles, names, values, checked/selected states, and hierarchy.

**Advantages:**
- Extremely compact output (Playwright already filters to meaningful elements)
- Includes computed accessibility roles and names
- Single API call
- Playwright handles cross-browser differences internally

**Disadvantages:**
- `page.accessibility.snapshot()` is marked as experimental and may change
- Does not include bounding box information
- Does not include HTML attributes directly (type, placeholder, pattern, etc.)
- The tree structure differs from the DOM structure (accessibility tree !== DOM tree)
- Cannot generate CSS selectors from accessibility nodes (no nodeId/backendNodeId)
- Insufficient for our needs: we need to map back to clickable Playwright locators

**Verdict:** Not sufficient as a standalone approach, but useful as a supplementary signal.

#### Approach C: CDP Protocol Direct Access

**Mechanism:** Use Chrome DevTools Protocol APIs directly (as browser-use does): `DOM.getDocument`, `DOMSnapshot.captureSnapshot`, `Accessibility.getFullAXTree`.

**Advantages:**
- Full access to all three data sources (DOM, snapshot, AX tree)
- Paint order and stacking context information
- Backend node IDs for direct element interaction
- Matches browser-use's proven approach exactly

**Disadvantages:**
- Chromium-only (CDP is not available in Firefox or WebKit via Playwright)
- Requires managing CDP sessions manually (`page.context().newCDPSession(page)`)
- Significantly more complex: browser-use's DOM service is ~2,500 lines
- Three parallel CDP calls per state extraction
- Must handle CDP session lifecycle (connect, disconnect, reconnect on navigation)
- Tightly couples to Chrome internals

**Verdict:** Overly complex for our needs given that we already have Playwright as an abstraction layer.

### 5.2 Recommended Approach: A (JS Injection) + Lightweight B (AX Snapshot)

The recommended approach combines:

1. **Primary: JavaScript injection** for DOM traversal, interactive element detection, attribute collection, bounding box computation, selector generation, and shadow DOM/iframe handling.

2. **Optional supplementary: `page.accessibility.snapshot()`** for accessibility role/name enrichment. If available, the AX snapshot data is merged with the JS-extracted data to provide richer labels. If not available (experimental API removed), the system degrades gracefully to HTML-only semantics.

This approach keeps the implementation self-contained within Playwright's API surface, requires no additional dependencies, works across browser engines, and stays under 600 lines of new code.

### 5.3 The Injected JavaScript Function

The core extraction happens in a single `page.evaluate()` call. Here is the function's high-level structure:

```javascript
() => {
  const INTERACTIVE_TAGS = new Set([
    'input', 'button', 'select', 'textarea', 'a', 'details', 'summary'
  ]);

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'menuitem', 'checkbox', 'radio', 'tab',
    'textbox', 'combobox', 'slider', 'spinbutton', 'option', 'searchbox'
  ]);

  const INCLUDE_ATTRS = [
    'type', 'name', 'id', 'value', 'placeholder', 'role',
    'aria-label', 'aria-expanded', 'aria-checked', 'aria-selected',
    'checked', 'selected', 'disabled', 'required', 'readonly',
    'href', 'for', 'accept', 'multiple', 'min', 'max',
    'minlength', 'maxlength', 'pattern', 'autocomplete',
    'contenteditable'
  ];

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'meta', 'link', 'head',
    'path', 'defs', 'clipPath', 'mask', 'pattern',
    'linearGradient', 'radialGradient', 'stop'
  ]);

  const elements = [];
  let nextIndex = 1;

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    const cursor = window.getComputedStyle(el).cursor;
    if (cursor === 'pointer') return true;
    return false;
  }

  function generateSelector(el) {
    // ... priority-based selector generation
  }

  function getAttributes(el) {
    const attrs = {};
    for (const attr of INCLUDE_ATTRS) {
      const val = el.getAttribute(attr);
      if (val !== null && val !== '') attrs[attr] = val;
    }
    // For inputs, also get the current .value property (not attribute)
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      attrs.value = el.value;
    }
    if (el.tagName === 'SELECT') {
      const selected = el.options[el.selectedIndex];
      if (selected) attrs.value = selected.text;
    }
    return attrs;
  }

  function walk(node, depth, contextTexts) {
    // Skip non-element/text nodes
    // Skip SKIP_TAGS
    // If text node with content, add to contextTexts
    // If element:
    //   If isInteractive(el) && isVisible(el):
    //     Assign index, collect attributes, generate selector, compute bbox
    //     Record preceding contextTexts as "label context"
    //   Recurse into children
    //   If el.shadowRoot: recurse into shadowRoot.childNodes
  }

  walk(document.body, 0, []);

  return {
    url: location.href,
    title: document.title,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    elements: elements
  };
}
```

### 5.4 File Structure

New and modified files:

| File | Action | Description |
|------|--------|-------------|
| `src/dom-extractor.ts` | **Create** | The `DOMExtractor` class: injected JS function, element map construction, serialization to LLM format |
| `src/types.ts` | **Modify** | Add `IndexedElement`, `ElementMap` interfaces; add `elementMap?: ElementMap` to `BrowserInstance` |
| `src/tools.ts` | **Modify** | Add `browser_get_state` tool; modify interaction tools to accept `index` parameter; add index resolution logic |
| `src/browser-manager.ts` | **Modify** | Minor: ensure `BrowserInstance` carries `elementMap` |

Estimated total new/changed code: ~800-1,000 lines.

### 5.5 Performance Budget

Target performance for `browser_get_state`:

| Operation | Target | Notes |
|-----------|--------|-------|
| `page.evaluate()` (DOM walk) | < 200ms | Single call, O(n) DOM traversal |
| Selector validation | < 100ms | Batched, sampling-based (validate 10% of selectors) |
| LLM format serialization | < 10ms | String building in TypeScript |
| **Total** | **< 300ms** | Per invocation |

For comparison, browser-use's full CDP pipeline takes 500-2,000ms per state extraction (three CDP calls + tree construction + serialization).

### 5.6 Iframe Handling Strategy

**Phase 1 (initial implementation):**
- Use `page.frames()` to enumerate all frames
- For same-origin frames: run the extraction JS in each frame via `frame.evaluate()`
- Merge results with frame context prefix
- Store `frameName` or `frameUrl` on `IndexedElement` for interaction routing

**Phase 2 (future enhancement):**
- For cross-origin frames: use `page.context().newCDPSession(page)` + `Target.attachToTarget()` if Chromium
- Graceful degradation: note cross-origin frames in output without indexing their content

### 5.7 Testing Strategy

Testing priorities:

1. **Unit tests for interactivity detection** -- Create HTML fixtures with various element types, test that the injected JS correctly classifies each as interactive/non-interactive
2. **Unit tests for selector generation** -- Verify generated selectors resolve to unique elements
3. **Integration tests with real pages** -- Test against static HTML pages that simulate common ATS form patterns (Greenhouse, Workday, Lever)
4. **Token count regression tests** -- Measure output token count and assert it stays within bounds
5. **Stale map detection tests** -- Verify that navigation invalidates the element map

---

## 6. Token Efficiency Analysis

### 6.1 Methodology

Token counts estimated using the ~4 characters per token approximation for GPT-4/Claude tokenizers, validated against typical job application page sizes.

### 6.2 Raw HTML Baseline

A typical Greenhouse job application page:

| Metric | Value |
|--------|-------|
| Raw `page.content()` size | ~120,000 characters |
| Estimated tokens | ~30,000 tokens |
| Interactive elements on page | ~15-25 |
| Percentage of HTML that is interactive | ~2-5% |
| Scripts + styles + SVG + tracking | ~70-80% of total |

### 6.3 browser_get_markdown Baseline

The existing markdown tool with default `maxLength=10000`:

| Metric | Value |
|--------|-------|
| Output size | 10,000 characters (truncated) |
| Estimated tokens | ~2,500 tokens |
| Interactive elements identified | 0 (no element indexing) |
| Usable for automation | No (read-only content view) |

### 6.4 Proposed browser_get_state

Expected output for the same Greenhouse page:

| Metric | Value |
|--------|-------|
| Header (url, title, scroll, viewport) | ~200 characters |
| Per interactive element (tag + attributes) | ~80-120 characters |
| Context text (headings, labels) | ~300-500 characters |
| Total for 20 interactive elements | ~2,400-3,100 characters |
| Total output size | ~2,600-3,800 characters |
| Estimated tokens | **~650-950 tokens** |

### 6.5 Token Savings Summary

| Approach | Tokens | Automation-Ready | Savings vs Raw HTML |
|----------|--------|------------------|---------------------|
| Raw HTML (`browser_get_page_info`) | ~30,000 | No (manual selector crafting) | Baseline |
| Markdown (`browser_get_markdown`) | ~2,500 | No (no element identity) | 92% fewer tokens, but not actionable |
| **Proposed `browser_get_state`** | **~800** | **Yes (index-based)** | **97% fewer tokens, fully actionable** |

### 6.6 Cost Impact

At current API pricing (~$3 per million input tokens for Claude Sonnet):

| Scenario | Pages/Job | Jobs/Day | Monthly Input Cost |
|----------|-----------|----------|-------------------|
| Raw HTML | 5 pages x 30K tokens | 50 jobs | ~$675/month |
| **Proposed** | 5 pages x 800 tokens | 50 jobs | ~$18/month |
| **Savings** | | | **~$657/month (97%)** |

This does not account for the additional savings from reduced output tokens (the LLM does not need to generate CSS selectors) and reduced retry loops (index-based targeting has a near-zero failure rate compared to LLM-crafted selectors).

---

## 7. Risk Assessment and Open Questions

### 7.1 Risks

**Risk 1: Selector reliability**
The injected JS generates CSS selectors for Playwright to use. If the selector is ambiguous (matches multiple elements) or fragile (breaks on minor DOM changes), interactions will fail.
*Mitigation:* Validate selectors during map construction. Use multiple attribute combinations. Fall back to nth-child positional selectors within stable parent containers.

**Risk 2: Element map staleness**
Between `browser_get_state` and subsequent interactions, the DOM may mutate (AJAX updates, React re-renders, modal overlays appearing).
*Mitigation:* URL-based staleness detection. If an interaction fails with "element not found," return a clear error suggesting `browser_get_state` refresh. Consider adding a lightweight staleness check (DOM mutation observer hash) in Phase 2.

**Risk 3: Shadow DOM selector generation**
Shadow DOM elements cannot be targeted with standard CSS selectors from the document root. Playwright's `>>` combinator is needed.
*Mitigation:* The extraction JS must track the chain of shadow hosts. Selectors are generated as `hostSelector >> innerSelector`. Test against known shadow DOM patterns (Workday uses extensive shadow DOM).

**Risk 4: Performance on heavy pages**
Pages with 10,000+ DOM nodes (common in SPAs) may cause the `querySelectorAll('*')` + `getComputedStyle()` loop to exceed 200ms.
*Mitigation:* Early termination at `maxDepth`. Skip non-visible subtrees. Batch `getComputedStyle` calls. Consider using `IntersectionObserver` for visibility instead of style checks.

**Risk 5: Cross-origin iframes remain a blind spot**
Many ATS platforms (Greenhouse, Lever) embed forms in iframes. If these are cross-origin, the JS injection approach cannot access them.
*Mitigation:* Phase 1 documents this limitation. Phase 2 adds CDP-based cross-origin iframe support for Chromium. In practice, many "cross-origin" ATS iframes are actually same-origin (served from the same domain via reverse proxy).

### 7.2 Open Questions

1. **Should `browser_get_state` replace `browser_get_page_info` or coexist?**
   Recommendation: Coexist. `browser_get_page_info` is useful for debugging and raw HTML inspection. `browser_get_state` is the primary tool for AI automation. In tool descriptions, guide the LLM toward `browser_get_state`.

2. **Should index numbers be sequential (1, 2, 3...) or use backend_node_id?**
   Recommendation: Sequential integers starting at 1. This is more compact and LLM-friendly than large backend_node_id numbers. The mapping from sequential index to actual element locator is internal.

3. **Should `<option>` elements inside `<select>` get individual indices?**
   Recommendation: No. The `<select>` element itself gets an index. Available options are listed as attributes. The `browser_select_option` tool takes the select's index + the option value/text. This avoids inflating the element count.

4. **Should we add a `browser_scroll_to_element` tool that takes an index?**
   Recommendation: Yes, in Phase 2. For now, `browser_scroll` (up/down) combined with `browser_get_state` refresh is sufficient.

5. **Should we support Playwright's text selectors (`text=Submit`) as a third targeting mode?**
   Recommendation: Not initially. Index-based targeting is sufficient. Text selectors can be added later if needed.

6. **How should the tool handle pages that are still loading?**
   Recommendation: `browser_get_state` should first call `page.waitForLoadState('domcontentloaded')` with a short timeout (5 seconds). If the page is still loading after that, extract what is available and note `"loading": true` in the header.

---

## Appendix A: browser-use File Reference

Files studied for this analysis:

| File | Lines | Purpose |
|------|-------|---------|
| `browser_use/mcp/server.py` | 1,604 | MCP server, tool definitions, `_get_browser_state()` |
| `browser_use/tools/views.py` | 159 | Action models (ClickElementAction, InputTextAction, etc.) |
| `browser_use/dom/views.py` | 1,042 | Data types (EnhancedDOMTreeNode, DOMSelectorMap, SerializedDOMState) |
| `browser_use/dom/service.py` | 1,135 | DOM service (CDP calls, tree construction, visibility detection) |
| `browser_use/dom/serializer/serializer.py` | 1,303 | Tree serialization (filtering, optimization, index assignment, LLM output) |
| `browser_use/dom/serializer/clickable_elements.py` | 247 | Interactive element detection heuristics |
| `browser_use/dom/enhanced_snapshot.py` | 176 | CDP snapshot parsing (bounds, styles, paint order) |

Total browser-use DOM subsystem: ~4,062 lines of Python.

## Appendix B: concurrent-browser-mcp File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `src/server.ts` | 132 | MCP server setup |
| `src/browser-manager.ts` | 388 | Browser instance lifecycle |
| `src/tools.ts` | 1,190 | Tool definitions and implementations |
| `src/types.ts` | 81 | TypeScript interfaces |
| `src/index.ts` | 134 | CLI entry point |

Total concurrent-browser-mcp: ~1,925 lines of TypeScript.

## Appendix C: Mapping of browser-use Tools to concurrent-browser-mcp

| browser-use Tool | Uses Index? | concurrent-browser-mcp Equivalent | Uses Selector? | Proposed Change |
|------------------|-------------|-------------------------------------|----------------|-----------------|
| `browser_get_state` | N/A (returns state) | `browser_get_page_info` | N/A | Add `browser_get_state` |
| `browser_click` | `index: int` | `browser_click` | `selector: string` | Add `index` param |
| `browser_type` | `index: int` | `browser_type` | `selector: string` | Add `index` param |
| `browser_clear_and_type` | `index: int` | (none) | N/A | Add new tool |
| `browser_select_option` | `index: int, text: str` | `browser_select_option` | `selector: string, value: str` | Add `index` param |
| `browser_select_combobox` | `index: int, text: str` | (none) | N/A | Add new tool (Phase 2) |
| `browser_navigate` | N/A | `browser_navigate` | N/A | No change |
| `browser_go_back` | N/A | `browser_go_back` | N/A | No change |
| `browser_scroll` | direction | (none) | N/A | Add new tool |
| `browser_extract_content` | N/A (uses LLM) | `browser_get_markdown` | N/A | No change (different approach) |
| `browser_execute_js` | `index: int` | `browser_evaluate` | N/A | Add `index` param (Phase 2) |
| `browser_upload_file` | `index: int, path: str` | (none) | N/A | Add new tool (Phase 2) |
