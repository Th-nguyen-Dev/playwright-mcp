# Three-Way Architecture Report: Playwright MCP vs Browser-Use vs Concurrent-Browser-MCP

> **Source-code-level analysis** of three forked repos in `explorer-workspace/`, combined with external research.
> Generated: 2026-02-11

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Page Representation: The Core Divergence](#3-page-representation-the-core-divergence)
4. [Tool System Design](#4-tool-system-design)
5. [Element Targeting Strategies](#5-element-targeting-strategies)
6. [Security Models](#6-security-models)
7. [Concurrency & Session Management](#7-concurrency--session-management)
8. [Token Efficiency & LLM Friendliness](#8-token-efficiency--llm-friendliness)
9. [Transport & Deployment](#9-transport--deployment)
10. [Custom Fork Modifications](#10-custom-fork-modifications)
11. [Head-to-Head Comparison Matrix](#11-head-to-head-comparison-matrix)
12. [When to Use Each](#12-when-to-use-each)
13. [Critical Gaps: Snapshot Coverage & Custom Widget Handling](#13-critical-gaps-snapshot-coverage--custom-widget-handling)
14. [The Future: Hybrid Approaches](#14-the-future-hybrid-approaches)
15. [Sources](#15-sources)

---

## 1. Executive Summary

These three projects represent **three fundamentally different philosophies** for giving AI agents browser control:

| Project | Core Philosophy | Page Representation | Language |
|---------|----------------|-------------------|----------|
| **Playwright MCP** | Accessibility-first, deterministic | YAML accessibility tree with `[ref=N]` | TypeScript (Playwright monorepo) |
| **Browser-Use** | DOM-first with vision hybrid | Indexed DOM tree with `[N]<tag>` markers | Python (CDP + event bus) |
| **Concurrent-Browser-MCP** | Direct Playwright API exposure | Raw HTML + CSS selectors | TypeScript (thin Playwright wrapper) |

**The fundamental question:** How should a browser communicate its state to an LLM?

- **Playwright MCP** says: *Give it the accessibility tree — what a screen reader sees*
- **Browser-Use** says: *Give it a curated DOM tree — what a developer sees in DevTools*
- **Concurrent-Browser-MCP** says: *Give it raw HTML — let the LLM figure it out*

---

## 2. Architecture Overview

### 2.1 Playwright MCP — Three-Layer Stack

```
┌─────────────────────────────────────────────────┐
│  MCP Protocol Layer (sdk/server.js)             │
│  STDIO / HTTP+SSE / Streamable HTTP             │
│  Heartbeat, session management, progress tokens │
├─────────────────────────────────────────────────┤
│  Tool System Layer (browserServerBackend.js)    │
│  ~70 tools across 7 capability groups           │
│  Capability-gated security, Zod schema parsing  │
│  Response builder with secret redaction         │
├─────────────────────────────────────────────────┤
│  Browser Automation Layer                       │
│  Context manager (lazy init, promise memoize)   │
│  Tab state (snapshot cache, modal tracking)     │
│  aria-ref selector engine → Playwright locators │
│  playwright-core v1.58.0-alpha                  │
└─────────────────────────────────────────────────┘
```

**Key files:**
- `node_modules/playwright/lib/mcp/sdk/server.js` — MCP protocol handler
- `node_modules/playwright/lib/mcp/browser/browserServerBackend.js` — Tool dispatcher
- `node_modules/playwright/lib/mcp/browser/context.js` — Browser lifecycle
- `node_modules/playwright/lib/mcp/browser/tab.js` — Page lifecycle & snapshot tracking
- `node_modules/playwright/lib/mcp/browser/tools/*.js` — 27 tool implementations
- `packages/extension/src/background.ts` — Chrome extension CDP relay

### 2.2 Browser-Use — Event-Driven Watchdog Architecture

```
┌─────────────────────────────────────────────────┐
│  MCP Server Layer (mcp/server.py)               │
│  1603 lines, 16 tools exposed                   │
│  Session management with auto-cleanup           │
│  Sensitive data auto-redaction                   │
├─────────────────────────────────────────────────┤
│  Agent Layer (agent/service.py - 4060 lines)    │
│  LLM orchestration, multi-step planning         │
│  System prompt templates (7 variants)           │
│  retry_with_browser_use_agent fallback          │
├─────────────────────────────────────────────────┤
│  Browser Session + Watchdog Layer               │
│  bubus event bus (dispatch → watchdog handlers) │
│  DOMWatchdog: 3-CDP-call DOM building pipeline  │
│  ScreenshotWatchdog: CDP Page.captureScreenshot │
│  DefaultActionWatchdog: Click/Type/Scroll/Nav   │
│  DownloadsWatchdog, SecurityWatchdog, etc.      │
├─────────────────────────────────────────────────┤
│  DOM Service Layer                              │
│  CDP: DOM.getDocument + Accessibility.getFullAX │
│       + DOMSnapshot.captureSnapshot             │
│  5-stage serialization pipeline                 │
│  Paint order filtering, clickable detection     │
└─────────────────────────────────────────────────┘
```

**Key files:**
- `browser_use/mcp/server.py` — MCP tool definitions (1603 lines)
- `browser_use/agent/service.py` — Core agent loop (4060 lines)
- `browser_use/browser/session.py` — Browser session manager (3552 lines)
- `browser_use/browser/watchdogs/*.py` — Event-driven action handlers
- `browser_use/dom/service.py` — DOM tree building (1134 lines)
- `browser_use/dom/serializer/serializer.py` — DOM serialization (1302 lines)
- `browser_use/tools/service.py` — Action execution (2595 lines)

**Total codebase: ~64,000 lines of Python**

### 2.3 Concurrent-Browser-MCP — Thin Playwright Wrapper

```
┌─────────────────────────────────────────────────┐
│  MCP Server (server.ts)                         │
│  STDIO transport, SIGINT/SIGTERM handlers       │
├─────────────────────────────────────────────────┤
│  Tool Definitions (tools.ts)                    │
│  18 tools → direct Playwright API calls         │
│  CSS selector targeting                         │
├─────────────────────────────────────────────────┤
│  Browser Manager (browser-manager.ts)           │
│  Map<UUID, BrowserInstance> registry             │
│  Automatic timeout cleanup (30min default)      │
│  Proxy auto-detection (env, port scan, macOS)   │
│  Multi-browser: Chromium, Firefox, WebKit       │
└─────────────────────────────────────────────────┘
```

**Key files:**
- `src/server.ts` — Entry point & MCP server
- `src/tools.ts` — 18 tool definitions
- `src/browser-manager.ts` — Instance lifecycle
- `src/types.ts` — TypeScript interfaces

**Total codebase: ~1,916 lines of TypeScript**

---

## 3. Page Representation: The Core Divergence

This is the single most important architectural decision in each project.

### 3.1 Playwright MCP: Accessibility Tree Snapshots

```yaml
# What the LLM sees:
- document "Contact Form":
  - banner [ref=e1]:
    - heading "Welcome" [ref=e2] [level=1]
    - link "Home" [ref=e3]
  - main [ref=e4]:
    - form [ref=e5]:
      - textbox "Name" [ref=e6]
      - textbox "Email" [required] [ref=e7]
      - combobox "Department" [ref=e8]:
        - option "Sales" [selected]
        - option "Support"
      - checkbox "Newsletter" [checked] [ref=e9]
      - button "Submit" [ref=e10]
```

**How it works internally:**

1. `tab.captureSnapshot()` calls `page._snapshotForAI({ track: 'response' })`
2. Playwright traverses the browser's accessibility tree (Chrome AXTree API)
3. Each interactive element gets a sequential numeric ref
4. Result serialized to YAML format
5. `aria-ref` is a **custom Playwright selector engine** that maps refs to DOM elements

**Ref resolution pipeline:**
```
LLM says: click ref=e10
  → tab.refLocator({ ref: 'e10', element: 'Submit button' })
    → page.locator('aria-ref=e10').describe('Submit button')
      → locator._resolveSelector()
        → getByRole('button', { name: 'Submit' })
          → Playwright clicks the actual DOM element
```

**Incremental diffing:** After the first full snapshot, subsequent snapshots only return changed nodes — reducing token usage from ~5KB to <500 bytes for minor updates.

### 3.2 Browser-Use: Curated DOM Tree with Index Markers

```
# What the LLM sees:
url: https://example.com/contact
title: Contact Form

Welcome
Home
[42]<a href="/home">Home</a>

Contact Form
Name
[43]<input type="text" placeholder="Name" />
Email
[44]<input type="email" placeholder="Email" required />
Department
[45]<select>
  <option selected>Sales</option>
  <option>Support</option>
</select>
Newsletter
[46]<input type="checkbox" checked />
[47]<button>Submit</button>
```

**How it works internally — 5-stage DOM serialization pipeline:**

1. **CDP Data Fetch** (3 parallel calls):
   - `DOM.getDocument(depth=-1, pierce=true)` — Full DOM tree including iframes
   - `Accessibility.getFullAXTree()` — Roles, names, states
   - `DOMSnapshot.captureSnapshot(computedStyles=['display','cursor','opacity'])` — Layout, paint order, bounds

2. **Merge into `EnhancedDOMTreeNode`** — Each node gets: tag, attributes, bounds, paint order, AX role, is_clickable

3. **Clickable Detection** (reduces tree by 70-90%):
   - Inherently interactive: `<a>`, `<button>`, `<input>`, `<select>`, `<textarea>`
   - ARIA roles: `role=button`, `role=link`, `role=checkbox`
   - Event-based: Elements with `onclick`, `onmousedown` handlers
   - CSS hints: `cursor: pointer` computed style
   - Custom widgets: Elements with `tabindex >= 0`

4. **Paint Order Filtering** — Removes 100% occluded elements (z-index analysis)

5. **Index Assignment** — Sequential integers assigned to surviving interactive elements

### 3.3 Concurrent-Browser-MCP: Raw HTML

```json
{
  "url": "https://example.com/contact",
  "title": "Contact Form",
  "content": "<!DOCTYPE html><html><head>...</head><body>... full raw HTML ...</body></html>",
  "contentLength": 45231,
  "viewport": { "width": 1280, "height": 720 },
  "loadState": "load",
  "stats": { "links": 15, "images": 3, "forms": 1, "scripts": 12, "stylesheets": 4 }
}
```

The LLM receives the **entire HTML** and must construct CSS selectors itself.

### 3.4 Representation Comparison

| Metric | Playwright MCP | Browser-Use | Concurrent-Browser-MCP |
|--------|---------------|-------------|----------------------|
| **Typical page size** | 2-10 KB (YAML) | 10-50 KB (indexed tree) | 50-500 KB (raw HTML) |
| **Elements shown** | Only semantic/interactive | Only clickable (70-90% filtered) | Everything |
| **Element targeting** | `ref=e10` (deterministic) | `index=47` (positional) | CSS selector (fragile) |
| **Layout information** | None | Bounding boxes, scroll position | None |
| **Occlusion handling** | Via AX tree z-order | Paint order filtering | None |
| **Iframe support** | Automatic (AX tree pierces) | CDP session routing | Not supported |
| **Build time** | ~50-100ms | ~200-500ms (3 CDP calls) | ~10ms (page.content()) |
| **Vision model needed** | No | Optional (improves accuracy) | No |

---

## 4. Tool System Design

### 4.1 Playwright MCP — Capability-Gated Tools (~70 total)

**Registration pattern:**
```javascript
const click = defineTabTool({
  capability: 'core',          // Determines if tool is exposed
  schema: {
    name: 'browser_click',
    inputSchema: z.object({
      element: z.string().optional(),  // Human-readable description
      ref: z.string(),                 // Exact ref from snapshot
      doubleClick: z.boolean().optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional()
    }),
    type: 'input'  // 'readOnly' | 'input' | 'action' | 'assertion'
  },
  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    const { locator, resolved } = await tab.refLocator(params);
    response.addCode(`await page.${resolved}.click();`);
    await tab.waitForCompletion(async () => {
      await locator.click({ button: params.button, modifiers: params.modifiers });
    });
  }
});
```

**Capability tiers:**

| Tier | Opt-In? | Tools | Purpose |
|------|---------|-------|---------|
| `core` | Always on | 19 | Navigate, click, type, snapshot, evaluate, drag, hover, select, press_key, go_back/forward |
| `core-tabs` | Always on | 1 | Tab management (list/create/close/select) |
| `core-install` | Always on | 1 | Browser binary installation |
| `vision` | `--caps vision` | 6 | Coordinate-based: mouse_click_xy, mouse_drag_xy, mouse_wheel |
| `pdf` | `--caps pdf` | 1 | Document generation |
| `testing` | `--caps testing` | 5 | Assertions: verify_element_visible, verify_text_visible |
| `tracing` | `--caps tracing` | — | Performance traces |

**Clever design patterns:**

1. **Modal state enforcement** — If a dialog/file-chooser is open, tools that don't clear modals get blocked:
   ```javascript
   if (modalStates.length && !tool.clearsModalState)
     response.addError('Tool does not handle the modal state.');
   ```

2. **Race against modals** — Snapshot capture races against dialog appearance:
   ```javascript
   return await Promise.race([
     action().then(() => []),      // Action completed normally
     modalPromise                   // Modal appeared during action
   ]);
   ```

3. **Code generation** — Every mutation produces copyable Playwright code:
   ```javascript
   response.addCode(`await page.getByRole('button', { name: 'Submit' }).click();`);
   ```

4. **Secret redaction** — Configured secrets are stripped from all outputs:
   ```javascript
   text = text.replaceAll(secretValue, `<secret>${secretName}</secret>`);
   ```

### 4.2 Browser-Use — Event-Driven Tools (16 MCP + Agent Fallback)

**Registration pattern:**
```python
# In mcp/server.py
@mcp.tool()
async def browser_click(index: int, new_tab: bool = False) -> str:
    element = await browser_session.get_dom_element_by_index(index)
    await browser_session.event_bus.dispatch(ClickElementEvent(node=element))
    return f"Clicked element {index}"
```

**Tool list:**

| Tool | Element Targeting | Unique Feature |
|------|------------------|----------------|
| `browser_navigate` | URL | Auto-creates session, applies CSS zoom |
| `browser_go_back` | — | Event bus dispatch |
| `browser_click` | Index | `new_tab` option extracts href |
| `browser_type` | Index | Sensitive data auto-redaction |
| `browser_clear_and_type` | Index | Click → Ctrl+A → Type (real user sim) |
| `browser_select_option` | Index | Fuzzy text matching, shows options on fail |
| `browser_select_combobox` | Index | Type → Wait → Scan → Click pattern |
| `browser_scroll` | — | Fixed 500px increments |
| `browser_get_state` | — | Returns full indexed DOM tree + optional screenshot |
| `browser_extract_content` | — | **LLM-powered** extraction (requires OPENAI_API_KEY) |
| `browser_execute_js` | Index | JS bound to specific element (`this` context) |
| `browser_upload_file` | Index | CDP DOM.setFileInputFiles, iframe-aware |
| `browser_switch_tab` | Tab ID | Shared cookies across tabs |
| `browser_close_tab` | Tab ID | — |
| `browser_list_tabs` | — | — |
| `retry_with_browser_use_agent` | — | **Full autonomous agent delegation** |

**The killer feature — `retry_with_browser_use_agent`:**
```python
@mcp.tool()
async def retry_with_browser_use_agent(
    task: str,               # Natural language: "Fill out the contact form"
    max_steps: int = 100,
    model: str = "gpt-4o",
    allowed_domains: list[str] = None,
    use_vision: bool = True
) -> str:
    agent = Agent(task=task, llm=model, browser_session=current_session)
    result = await agent.run(max_steps=max_steps)
    return result.final_result()
```

When low-level tools fail, the calling agent can delegate the **entire sub-task** to a fully autonomous browser-use AI agent. No other system has this.

### 4.3 Concurrent-Browser-MCP — Direct Playwright Mapping (18 tools)

```typescript
// In tools.ts — almost 1:1 Playwright API mapping
{
  name: 'browser_click',
  inputSchema: {
    instanceId: { type: 'string', required: true },
    selector: { type: 'string', required: true },   // CSS selector
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
    clickCount: { type: 'number' },
    delay: { type: 'number' },
    timeout: { type: 'number', default: 30000 }
  },
  handler: async ({ instanceId, selector, ...opts }) => {
    const instance = manager.getInstance(instanceId);
    await instance.page.click(selector, opts);
    return { success: true, instanceId };
  }
}
```

**Tool categories:**

| Category | Tools | Unique Features |
|----------|-------|-----------------|
| Instance mgmt | 4 | Multi-browser (Chromium/Firefox/WebKit), UUID-based, metadata tags |
| Navigation | 4 | `waitUntil` options (load/domcontentloaded/networkidle) |
| Interaction | 4 | Right-click, double-click, delay options |
| Page info | 4 | Full HTML return, element-level screenshots, HTML→Markdown converter |
| Waiting | 2 | `waitForSelector`, `waitForNavigation` |
| JavaScript | 1 | Arbitrary `page.evaluate()` |
| Content | 1 | Custom 169-line in-browser HTML→Markdown |

### 4.4 Tool Count & Proliferation Analysis

[Speakeasy research](https://www.speakeasy.com/blog/playwright-tool-proliferation) found that LLMs struggle at ~30 tools for large models and ~19 for smaller ones. Flask creator Armin Ronacher uses only 8 of Playwright MCP's 26+ tools regularly.

| System | Total Tools | Core Tools Used 90% of Time | Risk of Decision Paralysis |
|--------|-------------|---------------------------|---------------------------|
| Playwright MCP | ~70 (21 default) | ~8 | Low (capability gating) |
| Browser-Use | 16 | ~8 | Low |
| Concurrent-Browser-MCP | 18 | ~10 | Low-Medium |

Playwright MCP's **capability gating** is the best solution here — expose only what the task needs.

---

## 5. Element Targeting Strategies

This is where the three approaches diverge most sharply in practice.

### 5.1 Ref-Based (Playwright MCP)

```
LLM sees:  button "Submit" [ref=e10]
LLM says:  browser_click(ref="e10", element="Submit button")
Resolution: aria-ref=e10 → getByRole('button', { name: 'Submit' }) → DOM element
```

**Pros:**
- Deterministic — same snapshot = same refs
- No coordinate guessing, no selector fragility
- Works regardless of visual complexity
- Custom selector engine integrated into Playwright

**Cons:**
- Refs are scoped to current snapshot (invalidated on page change)
- Requires WCAG-compliant markup for best results
- Misses custom widgets without ARIA roles

### 5.2 Index-Based (Browser-Use)

```
LLM sees:  [47]<button>Submit</button>
LLM says:  browser_click(index=47)
Resolution: selector_map[47] → EnhancedDOMTreeNode → backendNodeId → CDP click
```

**Pros:**
- Simple integer reference
- Includes ALL clickable elements (not just semantic ones)
- Detects custom widgets via event handlers and cursor:pointer
- Two-step workflow ensures fresh state (get_state → click)

**Cons:**
- Indices change on any DOM mutation
- Requires extra round-trip (get_state before interact)
- No stable identifiers across navigation

### 5.3 CSS Selector-Based (Concurrent-Browser-MCP)

```
LLM sees:  <button class="btn-primary" id="submit-form">Submit</button>
LLM says:  browser_click(selector="#submit-form")
Resolution: page.click('#submit-form') → Playwright auto-waits → clicks
```

**Pros:**
- Familiar to developers
- No pre-fetch step needed
- Stable across page refreshes (if selectors are good)

**Cons:**
- LLM must construct selectors from raw HTML (error-prone)
- Fragile to DOM restructuring
- No "click the 3rd button" without `:nth-of-type(3)`
- Fails silently on non-unique selectors

### 5.4 Targeting Reliability Matrix

| Scenario | Ref (Playwright) | Index (Browser-Use) | CSS Selector (Concurrent) |
|----------|:-:|:-:|:-:|
| Dense date picker (24px cells) | Ref-per-day, exact | Index-per-day, exact | Selector ambiguity |
| Modal over content | AX tree respects z-order | Paint order filters occluded | Selector may hit background |
| Dynamic dropdown options | Snapshot after wait | Force DOM rebuild (3 retries) | `waitForSelector` needed |
| Iframe-embedded form | AX tree pierces frames | `cdp_client_for_node()` routing | Not supported |
| Canvas-based app (Figma) | Fails (no AX nodes) | Fails (no DOM elements) | Fails (no DOM elements) |
| Poorly-authored site (no ARIA) | Degrades (fewer refs) | Works (detects onclick/cursor) | Works (raw selectors) |

---

## 6. Security Models

### 6.1 Playwright MCP — Capability-Gated, Workspace-Sandboxed

**Three layers of defense:**

1. **Capability gating** — Sensitive tools require explicit `--caps` opt-in:
   ```bash
   npx @playwright/mcp@latest --caps vision,pdf  # Only these extras
   ```

2. **File access control** — Without `allowUnrestrictedFileAccess`:
   ```javascript
   browserContext._setAllowedProtocols(['http:', 'https:', 'about:', 'data:']);
   browserContext._setAllowedDirectories(clientInfo.roots);  // Workspace only
   ```

3. **Secret redaction** — Configured secrets stripped from all LLM outputs

4. **Network origin filtering** — Allowlist/blocklist for request origins

5. **Tool type annotations** — MCP protocol hints:
   ```javascript
   annotations: {
     readOnlyHint: true,
     destructiveHint: false,
     openWorldHint: true
   }
   ```

### 6.2 Browser-Use — Sensitive Data Detection

**Built-in heuristics:**
```python
is_sensitive = len(text) >= 6 and (
    ('@' in text and '.' in text.split('@')[-1])  # Email
    or (len(text) >= 16 and has_mixed_alphanum)    # API key
)
# Returns: "Typed <email> into element 5" instead of actual value
```

**Session auto-cleanup** — Idle sessions closed after 10 minutes (configurable)

**Domain restriction** — `allowed_domains` parameter on agent fallback

**Weaknesses:** No capability gating, no file access control, heuristic-only secret detection

### 6.3 Concurrent-Browser-MCP — Minimal Security

- No capability gating
- No secret redaction
- No file access control
- `browser_evaluate` executes **arbitrary JavaScript** with no sandboxing
- Instance isolation provides some process-level separation

### 6.4 Security Comparison

| Feature | Playwright MCP | Browser-Use | Concurrent-Browser-MCP |
|---------|:-:|:-:|:-:|
| Capability gating | Yes (7 tiers) | No | No |
| File access control | Yes (workspace-scoped) | No | No |
| Secret redaction | Yes (configurable) | Yes (heuristic) | No |
| Network filtering | Yes (origin allow/block) | Partial (domain restriction) | No |
| JS execution sandboxing | No (but gated behind capability) | No | No |
| Tool type annotations | Yes (MCP protocol) | No | No |

**Research backs this up:** The [arXiv paper](https://arxiv.org/html/2511.19477v1) concludes: *"Security must be enforced through deterministic, programmatic constraints instead of probabilistic reasoning."* Playwright MCP is the only one that fully implements this principle.

---

## 7. Concurrency & Session Management

### 7.1 Playwright MCP — Single Context, Multi-Tab

- One browser context per MCP connection
- Multiple tabs within that context (shared cookies/storage)
- Lazy initialization — browser not launched until first tool call
- Promise memoization prevents race conditions:
  ```javascript
  _ensureBrowserContext() {
    if (this._browserContextPromise) return this._browserContextPromise;
    this._browserContextPromise = this._setupBrowserContext();
    this._browserContextPromise.catch(() => {
      this._browserContextPromise = undefined; // Allow retry
    });
    return this._browserContextPromise;
  }
  ```

### 7.2 Browser-Use — Single Session, Multi-Tab with Agent

- Tab model: shared cookies/localStorage across tabs
- Session lifecycle management with auto-cleanup (background task every 2min)
- Activity tracking (`last_activity` timestamp per session)
- Event bus enables concurrent DOM building + screenshot capture (~50% latency reduction)

### 7.3 Concurrent-Browser-MCP — True Multi-Instance Isolation

- `Map<UUID, BrowserInstance>` registry with up to 20 instances (configurable)
- Each instance: independent browser process + context + page
- Complete isolation: no shared state between instances
- Automatic timeout cleanup (30min default, 5min check interval)
- Graceful shutdown on SIGINT/SIGTERM

**This is the key differentiator** — only concurrent-browser-mcp supports true parallel browser operations:

```javascript
// Create 3 independent browsers
const chrome = await create_instance({ browserType: 'chromium' });
const firefox = await create_instance({ browserType: 'firefox' });
const webkit = await create_instance({ browserType: 'webkit' });

// Run tasks in parallel across all three
await Promise.all([
  navigate(chrome, 'https://example.com'),
  navigate(firefox, 'https://example.com'),
  navigate(webkit, 'https://example.com')
]);
```

---

## 8. Token Efficiency & LLM Friendliness

### 8.1 Token Cost Per Interaction

| Operation | Playwright MCP | Browser-Use | Concurrent-Browser-MCP |
|-----------|---------------|-------------|----------------------|
| Page snapshot | 2-10 KB (YAML) | 10-50 KB (indexed tree) | 50-500 KB (raw HTML) |
| Incremental update | <500 bytes (diff) | Full rebuild required | Full HTML required |
| Screenshot | Not needed (text-only) | 800-1000 tokens (PNG) | Separate tool, base64 |
| Click response | Updated snapshot + code | Action result string | `{success, instanceId}` |
| 30-step session | ~$0.15 with caching | Higher (vision calls) | Highest (raw HTML) |

### 8.2 Response Quality

**Playwright MCP** returns rich, structured responses:
```markdown
### Result
Clicked "Submit" button

### Ran Playwright code
```js
await page.getByRole('button', { name: 'Submit' }).click();
```

### Page
- Page URL: https://example.com/success
- Page Title: Thank You
- Console: 0 errors

### Snapshot
```yaml
- heading "Thank You" [ref=e1]
- paragraph "Your form has been submitted." [ref=e2]
```

### Events
- Navigation: https://example.com/form → https://example.com/success
```

**Browser-Use** returns action results + optional state:
```
Clicked element 47 (Submit button)
```

**Concurrent-Browser-MCP** returns minimal acknowledgment:
```json
{ "success": true, "instanceId": "a1b2c3d4" }
```

### 8.3 Prefix Caching

Playwright MCP supports **89% cost reduction** on extended sessions via prefix caching — the YAML snapshot format is highly cacheable because most of the tree stays the same between actions.

Browser-Use has model-specific caching (Anthropic 4.5 models require 4096+ token prompts for caching).

Concurrent-Browser-MCP has no caching strategy.

---

## 9. Transport & Deployment

### 9.1 Transport Options

| Transport | Playwright MCP | Browser-Use | Concurrent-Browser-MCP |
|-----------|:-:|:-:|:-:|
| STDIO | Yes (default) | Yes | Yes (only) |
| HTTP/SSE | Yes | No | No |
| Streamable HTTP | Yes | No | No |
| WebSocket (extension) | Yes | No | No |
| Docker | Yes (multi-arch) | No | No |

### 9.2 Execution Modes

**Playwright MCP** has four:
1. **Persistent** — User data dir preserved across sessions
2. **Isolated** — Ephemeral in-memory profile (CI/CD)
3. **CDP Endpoint** — Connect to existing remote browser
4. **Extension Bridge** — Chrome extension relays CDP to existing tabs

The **Extension Bridge** is architecturally fascinating:
```
MCP Server ←WebSocket→ Chrome Extension ←CDP→ Existing Tab
```
The extension's `RelayConnection` forwards CDP commands/events between the MCP server and a user-selected Chrome tab, enabling automation of authenticated sessions.

**Browser-Use** has two:
1. Standard browser launch (Chromium only via CDP)
2. Connect to existing CDP endpoint

**Concurrent-Browser-MCP** has one:
1. Fresh browser launch per instance (Chromium/Firefox/WebKit)

### 9.3 IDE Integration

| IDE/Client | Playwright MCP | Browser-Use | Concurrent-Browser-MCP |
|------------|:-:|:-:|:-:|
| VS Code (Copilot) | Yes | No | No |
| Cursor | Yes | Yes | Yes |
| Claude Desktop | Yes | Yes | Yes |
| Claude Code | Yes | Yes | Yes |
| Windsurf | Yes | No | Likely |
| Cline | Yes | Yes | Yes |

---

## 10. Custom Fork Modifications

### 10.1 Browser-Use Fork (Th-nguyen-Dev/browser-use)

15 commits by NDLE Developer focused on **production form automation**:

| Commit | Feature | Problem Solved |
|--------|---------|---------------|
| `ffd4b1d8` | `browser_select_option` | Native `<select>` dropdowns (JS-based with fuzzy matching) |
| `27bce06d` | `browser_select_combobox` | Autocomplete dropdowns (Type→Wait→Scan→Click pattern) |
| `e456b40b` | Fix combobox | Force DOM rebuild before scanning options |
| `412dfae6` | Fix combobox text | Extract text from TEXT_NODE children recursively |
| `7a01e695` | `browser_upload_file` | CDP-based file input with DOM tree traversal |
| `eb0df910` | Fix file upload | Iframe-aware CDP session routing (`cdp_client_for_node()`) |
| `a5349fc9` | `browser_clear_and_type` | Click → Ctrl+A → Type for pre-filled fields |
| `89c0401f`→`28ed64f9` | `browser_get_text` lifecycle | Added, enhanced, refactored, **then removed** (redundant with get_state) |
| `d2e279c9`→`89169aef` | CSS zoom injection | 25% zoom for better vision model element detection |

**Key insight from combobox fix:** The DOM state is **cached** — after typing into an autocomplete field, the dropdown options don't appear in the cached DOM. The fix forces `await browser_session.get_browser_state_summary()` to rebuild the DOM fresh before scanning for `role=option` elements. Up to 3 retries with increasing delays.

**Key insight from file upload fix:** `self.browser_session.get_or_create_cdp_session()` always returns the main page CDP session. For iframe-embedded forms (Greenhouse ATS), this fails with "Node not found". Switching to `cdp_client_for_node(file_input_node)` routes to the correct iframe session.

### 10.2 Playwright MCP Fork (Th-nguyen-Dev/playwright-mcp)

Synced with upstream microsoft/playwright-mcp. No custom modifications observed — used as reference implementation.

### 10.3 Concurrent-Browser-MCP Fork (Th-nguyen-Dev/concurrent-browser-mcp)

Synced with upstream sailaoda/concurrent-browser-mcp. Includes proxy auto-detection feature from upstream.

---

## 11. Head-to-Head Comparison Matrix

### Architecture Quality

| Dimension | Playwright MCP | Browser-Use | Concurrent-Browser-MCP |
|-----------|:-:|:-:|:-:|
| **Codebase size** | Medium (~27 tools in Playwright monorepo) | Large (64K lines Python) | Small (1.9K lines TS) |
| **Separation of concerns** | Excellent (3-layer stack) | Good (event-driven watchdogs) | Good (Manager/Tools/Server) |
| **Error handling** | Comprehensive (modal detection, retry, redaction) | Good (BrowserError hierarchy) | Basic (try-catch, structured results) |
| **Type safety** | Strong (Zod schemas) | Strong (Pydantic models) | Strong (TypeScript strict) |
| **Testing** | Comprehensive (spec files per tool) | Minimal | None |

### Feature Comparison

| Feature | Playwright MCP | Browser-Use | Concurrent-Browser-MCP |
|---------|:-:|:-:|:-:|
| Cross-browser | Chromium, Firefox, WebKit | Chromium only | Chromium, Firefox, WebKit |
| Parallel instances | No (single context) | No (single session) | Yes (up to 20) |
| Extension bridge | Yes (Chrome/Edge) | No | No |
| AI agent fallback | No | Yes (full autonomous agent) | No |
| Code generation | Yes (every tool) | No | No |
| Incremental snapshots | Yes (diff-based) | No (full rebuild) | No |
| Secret redaction | Yes (configurable) | Yes (heuristic) | No |
| Capability gating | Yes (7 tiers) | No | No |
| File upload | Yes (workspace-scoped) | Yes (iframe-aware CDP) | No |
| Session logging | Yes (markdown export) | No | No |
| Proxy auto-detect | No | No | Yes (env, port scan, macOS) |
| Instance timeout cleanup | No | Yes (10min) | Yes (30min) |
| Sensitive data handling | Yes (redaction) | Yes (auto-detect) | No |
| Docker deployment | Yes (multi-arch) | No | No |
| HTTP/SSE transport | Yes | No | No |

---

## 12. When to Use Each

### Use Playwright MCP When:

- Building **CI/CD test automation** with clean, reproducible browser instances
- Token efficiency matters (accessibility tree is 5-20x smaller than raw HTML)
- You need **cross-browser testing** (Chromium + Firefox + WebKit)
- Security is critical (capability gating, file access control, secret redaction)
- You want **code generation** — learn Playwright API from tool outputs
- Deploying remotely (HTTP/SSE transport, Docker support)
- Working with well-authored sites (good ARIA markup)
- **Deterministic interactions** are more important than visual understanding

### Use Browser-Use When:

- Automating **complex real-world forms** (Greenhouse ATS, Workday, etc.)
- The site has **poor accessibility markup** (onclick handlers, cursor:pointer detection)
- You need an **autonomous agent fallback** when scripted approaches fail
- Working with **iframe-embedded content** (CDP session routing)
- You need **vision + structure hybrid** (screenshots + DOM tree)
- Building **custom dropdowns/comboboxes** (Type→Wait→Scan→Click pattern)
- **Session continuity** matters (shared cookies across tabs, auto-cleanup)
- You want **sensitive data auto-redaction** in logs

### Use Concurrent-Browser-MCP When:

- Running **parallel browser tasks** (scraping, comparison, multi-browser testing)
- You need **complete instance isolation** (no shared state)
- Working behind corporate proxies (auto-detection for Clash, V2Ray, system settings)
- Tasks are straightforward and **developer-familiar** (CSS selectors, Playwright primitives)
- You need **multi-browser** but don't need Playwright MCP's full complexity
- **No LLM dependency** — everything works without API keys
- **Lightweight/fast operations** — no DOM tree serialization overhead

---

## 13. Critical Gaps: Snapshot Coverage & Custom Widget Handling

This section addresses two confirmed limitations discovered during deep source-code analysis of Playwright MCP's AI-mode snapshot generation and form-filling tools.

### 13.1 What Playwright MCP's Accessibility Snapshot Actually Includes

The snapshot is generated via `page._snapshotForAI()` which configures the AX tree traversal in "AI mode":

```javascript
// From injectedScriptSource.js
if (options.mode === "ai") {
  return {
    visibility: "ariaOrVisible",      // Include visible + ARIA elements
    refs: "interactable",             // Only interactive elements get [ref=N]
    includeGenericRole: true,         // Generic div/span roles included
    renderCursorPointer: true         // cursor:pointer elements get refs
  };
}
```

**Included in the snapshot (visible to the LLM):**

| Element Type | Example | In Snapshot? | Gets `[ref=N]`? |
|---|---|:-:|:-:|
| Headings | `<h1>Apply for Position</h1>` | Yes | No |
| Paragraphs | `<p>Please fill out all fields</p>` | Yes | No |
| Tables, lists | `<table>`, `<ul>`, `<li>` | Yes | No |
| Links | `<a href="/jobs">View Jobs</a>` | Yes | Yes |
| Buttons | `<button>Submit</button>` | Yes | Yes |
| Text inputs | `<input type="text">` | Yes | Yes |
| Checkboxes, radios | `<input type="checkbox">` | Yes | Yes |
| Native `<select>` | `<select>` with `<option>` | Yes | Yes |
| Elements with `cursor: pointer` | Styled divs acting as buttons | Yes | Yes |
| Generic roles | `<div>`, `<span>` (with content) | Yes | No |

**States captured:** `checked`, `disabled`, `expanded`, `selected`, `pressed`, `level`, `active`
**Props captured:** `placeholder`, `url` (on links)

**Labels become accessible names:** A `<label for="email">Email Address</label>` paired with `<input id="email">` renders as `textbox "Email Address" [ref=e5]` — the label itself does not appear as a separate node.

### 13.2 The Non-Interactive Context Gap

While non-interactive elements (headings, paragraphs) ARE present in the tree and visible to the LLM, they do NOT receive `[ref=N]` identifiers. More critically:

**Properly associated descriptions ARE included:**
```html
<!-- This works — label text becomes the accessible name -->
<label for="email">Email Address</label>
<input id="email" type="email">
<!-- Snapshot: textbox "Email Address" [ref=e5] -->

<!-- This works — aria-describedby is part of the AX tree -->
<input id="pass" type="password" aria-describedby="pass-help">
<small id="pass-help">At least 8 characters</small>
```

**Loose descriptive text is MISSING:**
```html
<!-- This is LOST — no ARIA association, just visual proximity -->
<div class="form-group">
  <input type="text" placeholder="MM/DD/YYYY">
  <span class="help-text">Please enter date in MM/DD/YYYY format</span>
</div>
<!-- Snapshot only shows: textbox [placeholder=MM/DD/YYYY] [ref=e7] -->
<!-- The help text "Please enter date in MM/DD/YYYY format" is GONE -->
```

**Impact on job application sites:** Many ATS platforms (Greenhouse, Workday, Lever, iCIMS) use poorly-structured HTML where:
- Help text is positioned visually near inputs but NOT linked via `aria-describedby`
- Section descriptions are in `<div>` or `<span>` tags without semantic roles
- Validation error messages appear dynamically without ARIA associations
- Field grouping relies on visual layout rather than `<fieldset>`/`<legend>`

**Browser-Use comparison:** The DOM serializer includes ALL visible text content regardless of ARIA associations. The indexed tree format preserves:
- Help text near form fields (visible in the DOM tree as text nodes)
- Validation errors (detected via DOM mutation observation)
- Section descriptions (included as text content in parent containers)
- Visual grouping context (bounding box data shows spatial relationships)

### 13.3 The Custom Widget Problem

Playwright MCP's `browser_fill_form` tool supports exactly 5 input types:

```javascript
// From tools/form.js
const fillFormSchema = z.object({
  formData: z.array(z.object({
    ref: z.string(),
    value: z.string(),
    type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider'])
  }))
});
```

For `combobox` type, it calls `locator.selectOption()` — which **only works on native `<select>` elements**.

**The problem with real-world job sites:**

| ATS Platform | Component | Implementation | Playwright MCP Result |
|---|---|---|---|
| Greenhouse | Location selector | Custom `<div role="combobox">` + typed search + filtered dropdown | **Fails** — `selectOption()` throws "not a select element" |
| Workday | Department picker | Autocomplete widget with async option loading | **Fails** — options not in DOM until typed |
| Lever | Skills multi-select | Tag-based combobox with type-to-filter | **Fails** — no native select backing |
| iCIMS | Country dropdown | Styled `<div>` overlay hiding native select | **Partial** — may find hidden native select |

**Browser-Use fork's solution — dedicated tools for each pattern:**

1. **`browser_select_combobox`** (TYPE→WAIT→SCAN→CLICK):
   ```python
   # 1. Click to focus the combobox
   await element.click()
   # 2. Type the search text to trigger filtering
   await element.fill(search_text)
   # 3. Wait 400ms for debounce + DOM update
   await asyncio.sleep(0.4)
   # 4. Force DOM rebuild (cached state is stale)
   await browser_session.get_browser_state_summary()
   # 5. Scan for role=option elements in the fresh DOM
   options = find_options_in_dom(dom_tree)
   # 6. Click the matching option (up to 3 retries)
   await matching_option.click()
   ```

2. **`browser_select_option`** (JS-based fuzzy matching):
   ```python
   # Executes JavaScript directly on the <select> element
   # Uses text-based matching with normalization
   # Shows all available options on failure for LLM retry
   ```

3. **`browser_upload_file`** (iframe-aware):
   ```python
   # Problem: get_or_create_cdp_session() returns main page session
   # Solution: cdp_client_for_node(file_input_node) routes to correct iframe
   cdp = await browser_session.cdp_client_for_node(node)
   await cdp.send("DOM.setFileInputFiles", {
       "files": [file_path],
       "backendNodeId": node.backend_node_id
   })
   ```

### 13.4 Quantified Impact

Based on analysis of the Browser-Use fork's git history (15 commits by NDLE Developer), these custom tools were developed specifically to handle failures encountered on production job application sites:

| Gap | Playwright MCP | Browser-Use Fork | Sites Affected |
|---|:-:|:-:|---|
| Custom combobox | No support | TYPE→WAIT→SCAN→CLICK with 3 retries | Greenhouse, Workday, Lever |
| Async dropdown options | No support | Forced DOM rebuild + 400ms delay | Any site with debounced search |
| Cross-iframe file upload | Modal-based only | CDP `cdp_client_for_node()` routing | Greenhouse (iframe-embedded forms) |
| Pre-filled field clearing | `fill()` only | Click → Ctrl+A → Type | Edit profile / update forms |
| Dynamic option text extraction | N/A | Recursive TEXT_NODE traversal | Sites with complex option markup |
| 13+ ARIA role detection | Basic roles | Detects `combobox`, `listbox`, `option`, `menuitem`, `treeitem`, etc. | All custom widget libraries |

### 13.5 Recommendations

For a production job application automation pipeline:

1. **Playwright MCP alone is insufficient** for custom-widget-heavy ATS platforms
2. **Browser-Use fork's custom tools** directly address the most common failure modes
3. **A hybrid approach** would combine Playwright MCP's token-efficient snapshots with Browser-Use's custom widget handling
4. The ideal architecture would:
   - Use accessibility snapshots for initial page understanding (cheap, fast)
   - Detect custom widgets via ARIA role analysis (`role=combobox`, `role=listbox`)
   - Fall back to DOM-level interaction (TYPE→WAIT→SCAN→CLICK) for non-native widgets
   - Route CDP commands through iframe-aware sessions for embedded forms
   - Use vision as a last resort for completely non-semantic UIs

---

## 14. The Future: Hybrid Approaches

Research from [arXiv:2511.19477](https://arxiv.org/html/2511.19477v1) concludes:

> *"Model capability does not limit agent performance; architectural decisions determine success or failure."*

The optimal architecture **combines multiple approaches**:

1. **Primary:** Accessibility tree snapshots (cheap, deterministic, token-efficient)
2. **Supplementary:** DOM tree for elements missed by AX (custom widgets, onclick handlers)
3. **Fallback:** Vision for canvas-based content and poorly-marked-up sites
4. **Safety:** Programmatic constraints (not LLM judgment) for security enforcement

Playwright MCP already supports this via `--caps vision` for coordinate-based interactions alongside accessibility snapshots. The [arXiv paper](https://arxiv.org/html/2511.19477v1) achieved **~85% success rate** (vs ~50% for prior browser agents) with a hybrid approach, using:

- Accessibility snapshots for global context
- Vision for precise bounding box detection on canvas elements
- Bulk action batching: **57% faster, 41% fewer tokens** than sequential processing
- Prefix caching: **89% cost reduction** for extended sessions

The convergence path is clear: **accessibility-first with selective vision fallback**, wrapped in capability-gated security.

---

## 15. Sources

### Repositories Analyzed
- [microsoft/playwright-mcp (fork)](https://github.com/Th-nguyen-Dev/playwright-mcp)
- [browser-use (fork)](https://github.com/Th-nguyen-Dev/browser-use)
- [concurrent-browser-mcp (fork)](https://github.com/Th-nguyen-Dev/concurrent-browser-mcp)
- [microsoft/playwright-mcp (upstream)](https://github.com/microsoft/playwright-mcp)
- [sailaoda/concurrent-browser-mcp (upstream)](https://github.com/sailaoda/concurrent-browser-mcp)

### External Research
- [Building Browser Agents: Architecture, Security, and Practical Solutions (arXiv)](https://arxiv.org/html/2511.19477v1)
- [Why Less Is More: The Playwright Proliferation Problem (Speakeasy)](https://www.speakeasy.com/blog/playwright-tool-proliferation)
- [DeepWiki: Playwright MCP Architecture](https://deepwiki.com/microsoft/playwright-mcp)
- [Playwright MCP vs BrowserUse (Hacker News)](https://news.ycombinator.com/item?id=43490283)
- [BrowserUse Vision Capabilities (DeepWiki)](https://deepwiki.com/browser-use/browser-use/6.4-vision-capabilities)
- [6 Most Popular Playwright MCP Servers (Bug0)](https://bug0.com/blog/playwright-mcp-servers-ai-testing)
- [Playwright MCP Context7 Documentation](https://context7.com/microsoft/playwright-mcp)
