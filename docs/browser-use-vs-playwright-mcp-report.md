# Browser-Use MCP vs Playwright MCP: Detailed Implementation Comparison

## Overview

| | **browser-use** | **Playwright MCP** |
|---|---|---|
| Language | Python | TypeScript (source in Playwright monorepo) |
| Maintainer | browser-use (startup) | Microsoft (Playwright team) |
| Stars | ~15K | ~27K |
| Architecture | Event bus + CDP direct | Playwright API layer + accessibility tree |
| Element targeting | Integer index from DOM tree | `ref` string from accessibility snapshot |
| DOM representation | Custom CDP-based DOM tree serialization | Playwright's built-in accessibility snapshots |
| LLM dependency | Required for `browser_extract_content` and agent | None |
| Browser engines | Chromium only (via CDP) | Chromium, Firefox, WebKit |
| Concurrency | Single session, multiple tabs | Single session, multiple tabs |
| npm/pip package | `browser-use` (pip) | `@playwright/mcp` (npm) |

---

## Tool-by-Tool Comparison

### 1. PAGE STATE / DOM SNAPSHOT

#### browser-use: `browser_get_state` vs Playwright MCP: `browser_snapshot`

| | browser-use | Playwright MCP |
|---|---|---|
| **Approach** | 3 parallel CDP calls (DOM tree, DOMSnapshot, Accessibility tree) merged into `EnhancedDOMTreeNode` | Playwright's built-in `page.accessibility.snapshot()` |
| **Element IDs** | Integer indices: `[42]<input placeholder="Name" />` | String refs: `- textbox "Name" [ref=e5]` |
| **Representation** | HTML-like: `[42]<input type=text value=Sebastian placeholder=First name />` | Accessibility role-based: `- textbox "First name" [ref=e5]: Sebastian` |
| **Interactive detection** | Multi-signal heuristic: JS event listeners, HTML tags, ARIA roles, AX properties, cursor style (~4,062 lines across 7 files) | Playwright's accessibility tree (built into browser engine, zero custom code) |
| **Scroll context** | `scroll: y=0, viewport=800px, 0px above, 2000px below` | Included in page state section |
| **Tab list** | Included when multiple tabs open | Separate `### Open tabs` section in every response |
| **Screenshot** | Optional `include_screenshot` param (base64 in response) | Not part of snapshot (separate `browser_take_screenshot` tool) |
| **Browser errors** | Included in state header | Separate `### New console messages` section |
| **Code generation** | None | Every response includes generated Playwright code: `await page.getByRole('button', { name: 'Submit' }).click();` |
| **Incremental mode** | No — full tree every time | `--snapshot-mode=incremental` sends only changed parts |
| **Caching** | `_cached_selector_map` and `_cached_browser_state_summary` | Server-side snapshot caching with incremental diffs |
| **Implementation size** | ~4,062 lines of Python (dom/service.py, dom/views.py, dom/serializer/*.py) | Delegated to Playwright engine (zero custom DOM code) |

**Impact**: Playwright MCP's approach is dramatically simpler — it delegates DOM processing entirely to the browser engine's accessibility tree instead of building a custom CDP-based DOM extraction pipeline. The incremental snapshot mode also reduces token cost on repeated calls. browser-use's approach gives more raw detail (HTML attributes, CSS selectors, bounding boxes) but at enormous implementation complexity. For job application forms, the accessibility tree approach is arguably better since form elements always have proper ARIA roles.

**Output format comparison:**

browser-use:
```
url: https://jobs.example.com/apply
title: Apply - Software Engineer
scroll: y=0, viewport=800px, 0px above, 2000px below

[1]<input type=text placeholder=First name />
[2]<input type=text placeholder=Last name />
[3]<input type=email placeholder=Email />
[4]<select>
[5]<option value=us>United States</option>
[6]<option value=uk>United Kingdom</option>
[7]<button>Submit Application</button>
```

Playwright MCP:
```
### Snapshot
- textbox "First name" [ref=e1]
- textbox "Last name" [ref=e2]
- textbox "Email" [ref=e3]
- combobox "Country" [ref=e4]:
  - option "United States"
  - option "United Kingdom"
- button "Submit Application" [ref=e5]
```

---

### 2. CLICKING

#### browser-use: `browser_click` vs Playwright MCP: `browser_click`

| | browser-use | Playwright MCP |
|---|---|---|
| **Element targeting** | `index` (integer from `browser_get_state`) | `ref` (string like "e2" from `browser_snapshot`) |
| **Human description** | None | `element` (string, optional) — "Submit button" — used for permission verification |
| **New tab** | `new_tab` (boolean) — extracts href, opens in new tab | Not available as param (use `browser_tabs` to create new tab) |
| **Double click** | Not available | `doubleClick` (boolean) |
| **Mouse button** | Not configurable (always left) | `button` (string: left/right/middle) |
| **Modifiers** | Not available | `modifiers` (array: Alt, Control, Meta, Shift) |
| **Implementation** | Event bus dispatch → `ClickElementEvent` → CDP | Playwright's `locator.click()` resolved from accessibility ref |
| **Iframe support** | Yes — `cdp_client_for_node()` traverses frame hierarchy | Yes — Playwright handles frame traversal natively |
| **Response** | String: `"Clicked element 42"` | Structured markdown with snapshot + generated code |
| **Code generation** | None | Returns: `await page.getByRole('button', { name: 'Submit' }).click();` |

**Impact**: Playwright MCP's `element` parameter for human-readable descriptions is useful for audit trails and permission systems. The code generation in responses means every click produces a reusable Playwright test script. Modifier key support (Ctrl+click, Shift+click) is important for multi-select workflows. browser-use's new_tab parameter is more convenient than managing tabs separately.

---

### 3. TEXT INPUT

#### browser-use: `browser_type` vs Playwright MCP: `browser_type`

| | browser-use | Playwright MCP |
|---|---|---|
| **Element targeting** | `index` (integer) | `ref` (string) |
| **Text param** | `text` (string) | `text` (string) |
| **Submit after typing** | Not available | `submit` (boolean) — presses Enter after typing |
| **Slow typing** | Not configurable | `slowly` (boolean) — one character at a time for triggering key handlers |
| **Clear before type** | Separate tool: `browser_clear_and_type` | Default behavior — `browser_type` clears first (fills), `slowly` mode types character by character |
| **Sensitive data** | Auto-detects emails/credentials, redacts from response: `"Typed <email> into element 5"` | Uses `--secrets` config file — values matching secrets are masked in snapshots |
| **Implementation** | Event bus → `TypeTextEvent` with `is_sensitive` flag | Playwright's `locator.fill()` (default) or `locator.pressSequentially()` (slowly mode) |
| **Response** | String with value (or redacted) | Structured markdown with snapshot + generated code |

**Impact**: Playwright MCP's `submit` param saves an extra `browser_press_key` call for form submissions. The `slowly` option is critical for sites with autocomplete/typeahead that react to individual keystrokes. browser-use's auto-detection of sensitive data is more convenient (no config needed), but Playwright MCP's secrets file approach is more reliable (explicit rather than heuristic).

---

#### browser-use: `browser_clear_and_type` vs Playwright MCP: (built into `browser_type`)

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | Separate dedicated tool | Built into `browser_type` (default behavior is fill/clear) |
| **Implementation** | Click → Ctrl+A → type (3-step with deliberate delays: 0.1s, 0.1s) | Playwright's `locator.fill()` — native clear+set in one call |
| **Why separate?** | Because `browser_type` appends text (doesn't clear) | Not needed — `browser_type` always clears by default |

**Impact**: Playwright MCP's design is cleaner — one tool that defaults to clear+fill, with `slowly` option for keystroke-by-keystroke. browser-use needs two separate tools because its `browser_type` uses the raw `page.type()` which appends.

---

### 4. FORM FILLING

#### browser-use: (no equivalent) vs Playwright MCP: `browser_fill_form`

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | **NOT AVAILABLE** — must fill fields one at a time | Available |
| **Params** | — | `fields` (array of field objects) |
| **Batch filling** | — | Fill multiple form fields in a single tool call |

**Impact**: For job applications with 10-20 fields, Playwright MCP's batch form filling saves 10-20 round trips. This is a significant efficiency gain for the pride-riot use case.

---

### 5. DROPDOWNS & SELECT

#### browser-use: `browser_select_option` vs Playwright MCP: `browser_select_option`

| | browser-use | Playwright MCP |
|---|---|---|
| **Element targeting** | `index` (integer) | `ref` (string) |
| **Value param** | `text` (string) — visible text, case-insensitive partial match | `values` (array of strings) — supports multi-select |
| **Matching** | Fuzzy: exact first, then partial contains. Shows available options on failure | Exact match via Playwright's `selectOption()` |
| **Multi-select** | No — single value only | Yes — `values` is an array |
| **Error feedback** | Returns first 10 available options if no match | Standard Playwright error |
| **Implementation** | CDP `Runtime.callFunctionOn` with custom JS — dispatches `input` + `change` events | Playwright's `locator.selectOption()` |
| **Iframe support** | Yes — `cdp_client_for_node()` | Yes — Playwright handles natively |

**Impact**: browser-use's fuzzy matching and error feedback showing available options is more AI-friendly for self-correction. Playwright MCP's multi-select support is useful for skills/tags fields on job applications. Different strengths for different scenarios.

---

#### browser-use: `browser_select_combobox` vs Playwright MCP: (no equivalent)

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | Dedicated tool | **NOT AVAILABLE** — must orchestrate click → type → wait → click manually |
| **Implementation** | Click → Ctrl+A → type → wait up to 3 attempts → find `role=option` → click | — |

**Impact**: browser-use's combobox handler is valuable for modern ATS systems (Greenhouse, Lever) that use custom autocomplete dropdowns. With Playwright MCP, you'd need to manually chain `browser_click` → `browser_type(slowly=true)` → `browser_wait_for` → `browser_click` on the option. Doable but more error-prone.

---

### 6. SCROLLING

#### browser-use: `browser_scroll` vs Playwright MCP: `browser_mouse_wheel`

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | Core tool | Opt-in via `--caps=vision` |
| **Direction** | `direction` (enum: up, down) | `deltaX`, `deltaY` (numbers — full 2D control) |
| **Amount** | Fixed 500px per call | Arbitrary pixel values |
| **Element scrolling** | Not in MCP tool (internal `ScrollAction` supports element `index` + `pages`) | Not element-specific (viewport only) |
| **Implementation** | Event bus → `ScrollEvent` | Playwright's `page.mouse.wheel()` |

**Impact**: Playwright MCP's approach gives more precise control (exact pixel amounts, horizontal scrolling) but requires opting into vision capabilities. browser-use's is simpler but rigid (always 500px). For long job application forms, precise scroll control is useful.

---

### 7. JAVASCRIPT EXECUTION

#### browser-use: `browser_execute_js` vs Playwright MCP: `browser_evaluate` + `browser_run_code`

| | browser-use | Playwright MCP `browser_evaluate` | Playwright MCP `browser_run_code` |
|---|---|---|---|
| **Scope** | Element-bound (`this` = target element) | Page or element-bound (optional `ref`) | Full Playwright API (`page` object) |
| **Element targeting** | `index` (integer, required) | `ref` (string, optional) | N/A — use Playwright locators in code |
| **Script format** | Function body string | `() => { code }` or `(element) => { code }` | `async (page) => { ... }` |
| **Return value** | CDP result value | Evaluated result | Any return value |
| **Iframe support** | Yes — CDP `cdp_client_for_node()` | Yes — Playwright handles natively | Yes — full Playwright API |
| **Complexity** | Simple — run JS on one element | Medium — page or element scope | Unlimited — full Playwright automation |

**Impact**: Playwright MCP offers two levels: `browser_evaluate` for quick JS on the page/element, and `browser_run_code` for full Playwright scripts (navigation, waiting, complex interactions). `browser_run_code` is extremely powerful — it's essentially an escape hatch to run arbitrary Playwright automation. browser-use's element-bound execution is simpler but more limited.

---

### 8. WAITING

#### browser-use: (no explicit wait) vs Playwright MCP: `browser_wait_for`

| | browser-use | Playwright MCP |
|---|---|---|
| **Wait for text** | Not available | `text` (string) — wait for text to appear |
| **Wait for text gone** | Not available | `textGone` (string) — wait for text to disappear |
| **Wait for time** | Not available | `time` (number, seconds) |
| **Implementation** | Relies on event bus delays and built-in action waits | Playwright's page polling |

**Impact**: Playwright MCP's `browser_wait_for` is essential for SPAs and dynamic forms. Waiting for "Loading..." to disappear or "Success" to appear is a common pattern in job application flows. browser-use has no MCP-exposed wait tool — its internal `wait_between_actions` profile setting is the only mechanism.

---

### 9. NAVIGATION

#### browser-use: `browser_navigate` vs Playwright MCP: `browser_navigate`

| | browser-use | Playwright MCP |
|---|---|---|
| **URL param** | `url` (string, required) | `url` (string, required) |
| **New tab** | `new_tab` (boolean, default false) | Not available (use `browser_tabs` action: "new") |
| **Timeout** | Not configurable | `--timeout-navigation` config (default 60s) |
| **Wait condition** | Implicit (event bus handles page load) | Playwright's default load detection |
| **Auto-init** | Creates browser session if none exists | Creates browser on first tool call |
| **Post-navigate** | Applies 25% CSS zoom (`document.documentElement.style.zoom = "0.25"`) | No modification |
| **Response** | String: `"Navigated to: {url}"` | Structured markdown with snapshot + code |

**Impact**: browser-use's forced 25% CSS zoom is opinionated and potentially problematic — it affects viewport calculations and screenshots. Playwright MCP's response includes a full snapshot after navigation, saving a separate `browser_snapshot` call.

---

#### browser-use: `browser_go_back` vs Playwright MCP: `browser_navigate_back`

| | browser-use | Playwright MCP |
|---|---|---|
| **Params** | None | None |
| **Forward navigation** | **NOT AVAILABLE** | **NOT AVAILABLE** |
| **Response** | String: `"Navigated back"` | Structured markdown with snapshot |

**Impact**: Neither has forward navigation. Playwright MCP's response includes updated snapshot.

---

### 10. SCREENSHOTS

#### browser-use: (part of `browser_get_state`) vs Playwright MCP: `browser_take_screenshot`

| | browser-use | Playwright MCP |
|---|---|---|
| **Standalone tool** | No — only via `browser_get_state(include_screenshot=true)` | Yes — dedicated tool |
| **Full page** | Not configurable | `fullPage` (boolean) |
| **Element screenshot** | Not available | `element` + `ref` params |
| **Format** | PNG only, base64 | `type` (png/jpeg) |
| **Save to file** | Not available | `filename` param — saves to output dir |
| **Response** | Base64 string embedded in state | Image attachment in MCP response |

**Impact**: Playwright MCP's screenshot tool is far more capable. The `filename` save option is useful for documenting job application submissions.

---

### 11. TAB MANAGEMENT

#### browser-use: 3 separate tools vs Playwright MCP: 1 unified tool

| | browser-use | Playwright MCP |
|---|---|---|
| **List tabs** | `browser_list_tabs` | `browser_tabs(action: "list")` |
| **Create tab** | `browser_navigate(url, new_tab=true)` | `browser_tabs(action: "new")` |
| **Switch tab** | `browser_switch_tab(tab_id)` — 4-char ID | `browser_tabs(action: "select", index: N)` — numeric index |
| **Close tab** | `browser_close_tab(tab_id)` | `browser_tabs(action: "close", index: N)` |
| **Tab identifier** | 4-character string hash of target_id | Numeric index |

**Impact**: Playwright MCP's unified `browser_tabs` tool is cleaner (one tool vs three). browser-use's 4-char tab IDs are more stable across operations; Playwright MCP's numeric indices can shift when tabs are closed.

---

### 12. FILE UPLOAD

#### browser-use: `browser_upload_file` vs Playwright MCP: `browser_file_upload`

| | browser-use | Playwright MCP |
|---|---|---|
| **Element targeting** | `index` (integer) — searches DOM tree for nearest `<input type=file>` | No element targeting — handles active file chooser dialog |
| **File param** | `path` (string, single file) | `paths` (array, single or multiple files) |
| **Multi-file** | No | Yes |
| **Cancel upload** | Not available | Omit `paths` to cancel file chooser |
| **File validation** | Checks file exists and is non-empty | Restricted to workspace roots by default (`--allow-unrestricted-file-access` to override) |
| **Iframe support** | Yes — CDP `cdp_client_for_node()` | Yes — Playwright handles natively |
| **Implementation** | CDP `DOM.setFileInputFiles` on resolved backend node | Playwright's file chooser API |

**Impact**: Playwright MCP's multi-file upload and security restrictions (workspace-only by default) are more production-ready. browser-use's approach of finding the nearest file input is more forgiving when the exact element isn't targeted.

---

### 13. DIALOG HANDLING

#### browser-use: (not available) vs Playwright MCP: `browser_handle_dialog`

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | **NOT AVAILABLE** in MCP (handled by PopupsWatchdog internally) | Available |
| **Accept/dismiss** | — | `accept` (boolean) |
| **Prompt text** | — | `promptText` (string, optional) |

**Impact**: Playwright MCP exposes dialog handling to the LLM. Job sites sometimes show confirmation dialogs ("Are you sure you want to submit?") that need explicit handling.

---

### 14. KEYBOARD

#### browser-use: (not available) vs Playwright MCP: `browser_press_key`

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | **NOT AVAILABLE** as MCP tool (internal `SendKeysAction` exists) | Available |
| **Param** | — | `key` (string: "Enter", "Escape", "Tab", "ArrowDown", etc.) |

**Impact**: Essential for form navigation (Tab between fields), dismissing modals (Escape), and triggering actions (Enter to submit). browser-use has the internal capability but doesn't expose it via MCP.

---

### 15. HOVER

#### browser-use: (not available) vs Playwright MCP: `browser_hover`

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | **NOT AVAILABLE** | Available |
| **Params** | — | `element` (string), `ref` (string) |

**Impact**: Useful for revealing tooltip content, dropdown menus, or hover-triggered form fields.

---

### 16. DRAG AND DROP

#### browser-use: (not available) vs Playwright MCP: `browser_drag`

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | **NOT AVAILABLE** | Available |
| **Params** | — | `startElement`/`startRef` → `endElement`/`endRef` |

**Impact**: Relevant for resume builders, form ordering, or priority ranking on some ATS platforms.

---

### 17. AI AGENT FALLBACK

#### browser-use: `retry_with_browser_use_agent` vs Playwright MCP: (no equivalent)

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | Available | **NOT AVAILABLE** |
| **Task description** | `task` (string, natural language) | — |
| **Max steps** | `max_steps` (integer, default 100) | — |
| **Model** | `model` (string, default gpt-4o, supports Bedrock) | — |
| **Domain restriction** | `allowed_domains` (array) | — |
| **Vision** | `use_vision` (boolean, default true) | — |
| **Cost** | Additional LLM API calls | — |

**Impact**: browser-use's AI agent fallback is a powerful escape hatch for complex/unpredictable pages. Playwright MCP has no equivalent — but `browser_run_code` can serve as a deterministic escape hatch (run arbitrary Playwright scripts).

---

### 18. CONTENT EXTRACTION

#### browser-use: `browser_extract_content` vs Playwright MCP: (no equivalent)

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | Available | **NOT AVAILABLE** (snapshot is the content) |
| **Approach** | LLM-powered query-based extraction | — |
| **Cost** | Additional LLM API call | — |

**Impact**: browser-use can answer questions about page content ("What is the salary range?"). Playwright MCP relies on the LLM client to interpret the accessibility snapshot directly.

---

### 19. NETWORK & CONSOLE INSPECTION

#### browser-use: (not available) vs Playwright MCP: `browser_network_requests` + `browser_console_messages`

| | browser-use | Playwright MCP |
|---|---|---|
| **Network requests** | **NOT AVAILABLE** | `browser_network_requests` with `includeStatic` filter |
| **Console messages** | Part of `browser_get_state` (browser errors only) | `browser_console_messages` with level filter (error/warning/info/debug) |
| **Save to file** | — | `filename` param on both tools |

**Impact**: Network request inspection is valuable for debugging failed form submissions (see the actual API response). Console messages help diagnose JavaScript errors on broken ATS pages.

---

### 20. WINDOW MANAGEMENT

#### browser-use: (not available) vs Playwright MCP: `browser_resize`

| | browser-use | Playwright MCP |
|---|---|---|
| **Availability** | Via BrowserProfile at init only | Available as runtime tool |
| **Params** | — | `width`, `height` (numbers) |

---

### 21. BROWSER SESSION & PROFILE

| | browser-use | Playwright MCP |
|---|---|---|
| **Profile persistence** | `user_data_dir` config option | `--user-data-dir` flag (default: `~/.cache/ms-playwright/mcp-{channel}-profile`) |
| **Isolated mode** | Not available | `--isolated` flag — ephemeral session |
| **Storage state** | `StorageStateWatchdog` for periodic export | `--storage-state` flag — load at startup |
| **Connect to existing browser** | Not available | `--extension` flag + browser extension, or `--cdp-endpoint` |
| **Device emulation** | Not available | `--device "iPhone 15"` |
| **Init scripts** | Not available | `--init-script` (JS) and `--init-page` (TS with Playwright page object) |
| **Secrets management** | Auto-detection heuristic | `--secrets` dotenv file — explicit secret masking |
| **Session timeout** | Configurable (default 10min), auto-cleanup every 2min | No auto-cleanup |
| **Telemetry** | Yes — sends tool call metrics to browser-use servers | None |

**Impact**: Playwright MCP's `--extension` mode is a game-changer for job applications — connect to a browser where you're already logged into LinkedIn, Workday, etc. No need to import cookies or manage auth state. The `--init-page` and `--init-script` options allow custom setup (e.g., blocking tracking scripts, setting geolocation).

---

### 22. RESPONSE FORMAT

| | browser-use | Playwright MCP |
|---|---|---|
| **Format** | Plain text strings | Structured markdown with `### Section` headers |
| **Sections** | Single string per response | Snapshot, Code, Open tabs, Page state, Console, Modal state, Downloads, Errors |
| **Code generation** | None | Every action generates reusable Playwright code |
| **Snapshot in response** | Only from `browser_get_state` | Included in every tool response automatically |

**Impact**: Playwright MCP's structured response format is significantly more informative. Getting a fresh snapshot after every action means the LLM always has current page state without needing a separate call. The code generation creates an audit trail of all actions taken.

---

### 23. CAPABILITIES SYSTEM

| | browser-use | Playwright MCP |
|---|---|---|
| **Modular tools** | No — all 19 tools always available | Yes — capabilities: core, vision, pdf, testing, devtools, network |
| **Vision tools** | Not available | Opt-in: coordinate-based clicking, mouse movement, wheel scroll |
| **PDF tools** | Not available | Opt-in: `browser_pdf_save` |
| **Testing tools** | Not available | Opt-in: verify element/text/value visible, generate locators |

**Impact**: Playwright MCP's capability system keeps the tool list lean by default (only core tools) and lets you opt into additional capabilities as needed. The testing tools are valuable for verifying form submission success.

---

## Architectural Comparison

### DOM Processing Pipeline

**browser-use** (4,062 lines, custom):
```
CDP DOM.getDocument()  ─┐
CDP Accessibility.getFullAXTree()  ─┼─→ EnhancedDOMTreeNode tree ─→ DOMTreeSerializer ─→ LLM text
CDP DOMSnapshot.captureSnapshot() ─┘     (merge 3 data sources)      (clickable detection)
```

**Playwright MCP** (delegated to engine):
```
Playwright page.accessibility.snapshot() ─→ Accessibility tree ─→ Ref-annotated text
```

### Event Architecture

**browser-use**:
```
MCP Tool Call → event_bus.dispatch(Event) → Watchdog Handler → CDP Operations → event.result()
                                              ↑
                                11 watchdogs: DOM, Screenshot, Downloads, Popups,
                                              Security, Crash, Storage, Permissions,
                                              Recording, LocalBrowser, AboutBlank
```

**Playwright MCP**:
```
MCP Tool Call → Playwright API → Browser Engine → Result → Structured Markdown Response
```

### Concurrency Model (neither solves this)

Both use: **Single browser process → Single browser context → Multiple tabs (pages)**

---

## Summary: Tools Only in One

### Only in browser-use (6 tools):
| Tool | Purpose | Workaround in Playwright MCP |
|---|---|---|
| `browser_select_combobox` | Custom autocomplete dropdowns | Chain: click → type(slowly) → wait_for → click |
| `browser_execute_js` (element-bound) | JS with `this` = element | `browser_evaluate` with `ref` param |
| `browser_extract_content` | LLM-powered content extraction | LLM interprets snapshot directly |
| `retry_with_browser_use_agent` | Full AI agent delegation | `browser_run_code` for scripted fallback |
| `browser_list_sessions` / `browser_close_session` | Session lifecycle management | Single session model, no equivalent needed |
| Auto-sensitive-data detection | Heuristic credential redaction | `--secrets` config file |

### Only in Playwright MCP (14+ tools):
| Tool | Purpose | Workaround in browser-use |
|---|---|---|
| `browser_fill_form` | Batch fill multiple fields | Call `browser_type` per field (N round-trips) |
| `browser_press_key` | Keyboard input (Enter, Tab, Escape) | Not available |
| `browser_hover` | Hover to reveal menus/tooltips | Not available |
| `browser_drag` | Drag and drop elements | Not available |
| `browser_handle_dialog` | Accept/dismiss alerts/confirms | Handled internally by PopupsWatchdog |
| `browser_wait_for` | Wait for text/time | Not available |
| `browser_resize` | Resize viewport at runtime | Profile config only (at init) |
| `browser_network_requests` | Inspect network traffic | Not available |
| `browser_console_messages` | Get console logs by level | Partial (errors only in state) |
| `browser_take_screenshot` | Standalone screenshot with save | Only via `browser_get_state(include_screenshot=true)` |
| `browser_run_code` | Run arbitrary Playwright scripts | Not available |
| `browser_tabs` (unified) | Unified tab management | 3 separate tools |
| `browser_pdf_save` | Save page as PDF | Not available |
| `browser_install` | Install browser | Not available |
| Vision tools (6) | Coordinate-based mouse control | Not available |
| Testing tools (5) | Assertions and locator generation | Not available |

---

## Recommendation for Pride-Riot

**Fork Playwright MCP** (already done) and add:

1. **Multi-instance concurrency** — the only thing it's missing
2. **Combobox handling** — port the concept from browser-use (click → type slowly → wait → click option), can be implemented as a composite tool or a `browser_run_code` recipe
3. **Shared auth via `--storage-state`** — already supported, just needs multi-instance extension

What you get for free by using Playwright MCP as the base:
- Battle-tested Playwright engine (27K stars, Microsoft backing)
- Accessibility-based DOM snapshots (zero custom DOM code to maintain)
- 30+ tools covering every interaction pattern
- Code generation in every response
- Browser extension for connecting to existing authenticated sessions
- Incremental snapshots for token efficiency
- Multi-browser support (chromium, firefox, webkit)
- Active development with weekly updates
- Proper test suite
- Docker support
- TypeScript (same language as concurrent-browser-mcp, easier to extend)
