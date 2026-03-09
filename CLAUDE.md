# CLAUDE.md — playwright-mcp

Fork of Microsoft's Playwright MCP with a custom multiplexer package. Used as a submodule by Explorer workspace projects.

## Repository Structure

npm workspaces monorepo. Root `package.json` declares `"workspaces": ["packages/*"]` — new packages under `packages/` are auto-included.

```
packages/
  playwright-mcp/               # @playwright/mcp — enhanced fork of Microsoft's MCP server
  playwright-mcp-multiplexer/   # Custom multi-instance multiplexer (main addition)
  playwright-cli-stub/          # CLI stub package
  extension/                    # Browser extension
playwright/                     # Fork of microsoft/playwright (dependency, not directly modified)
docs/
  AI-AGENT-GUIDE.md             # Guide for AI agents using DOM state files
  specs/file-based-dom-state.md # DOM state architecture design doc
```

## Build, Test, and Lint Commands

```bash
# From repo root — runs across all workspace packages
npm run build
npm run test
npm run lint

# Multiplexer package — MUST build before running tests
cd packages/playwright-mcp-multiplexer
npx tsc                # Build (outputs to dist/)
npx tsc --noEmit       # Typecheck / lint
npx playwright test    # Run all tests (requires dist/ to be current)
npx playwright test tests/multiplexer.spec.ts              # Single test file
npx playwright test -g "should create, list, and close"    # Single test by name

# @playwright/mcp package
cd packages/playwright-mcp
npm run build          # Runs build script inside ../../playwright fork
npm run ctest          # Chrome tests only
npm run ftest          # Firefox tests only
npm run wtest          # WebKit tests only
```

## Architecture

### Multiplexer Package (`packages/playwright-mcp-multiplexer/`)

The multiplexer wraps multiple independent `@playwright/mcp` child processes behind a single MCP server. It is the primary custom component in this fork.

**Entry point:** `cli.ts` — combined binary with two modes:
- Default (no subcommand): Multiplexer mode — starts the `MultiplexerServer`
- `child` subcommand: Single-browser `@playwright/mcp` mode — the multiplexer spawns copies of itself with `child` prepended to `process.argv`

**Core classes:**

`InstanceManager` (`src/instance-manager.ts`)
- Spawns child `@playwright/mcp` processes via `StdioClientTransport`
- Manages instance lifecycle: create → ready → closed
- Default `maxInstances`: 10; default `authDir`: `~/.pride-riot/auth/`
- Profile copying for Chrome: copies specific auth-relevant files from `<userDataDir>/<profileName>/` into a temp dir — includes `Local State` at the top level so Chrome can decrypt cookies
- Profile copying for Firefox: copies entire profile directory, skipping cache and lock files
- "Headless" instances use Xvfb virtual displays (`:10`–`:99`) via `VirtualDisplayManager` — Chrome always runs in headed mode against a virtual display rather than using Chrome's `--headless` flag (same rendering engine, avoids bot-detection signals)
- Sets `PW_DOM_STATE_INSTANCE_ID` and `PW_DOM_STATE_WORKSPACE` env vars on child processes for DOM state isolation; sets `PW_DOM_STATE_DISABLED=1` when `domState: false`
- Creates a JSON launch config file per instance with browser launch args; always sets `headless: false` in the config (Xvfb handles visibility)
- `--class=pw-mux` WM_CLASS is set on Chrome instances for Hyprland workspace routing
- `--disable-features=EnableBoundSessionCredentials` prevents DBSC from invalidating copied cookies

`ToolRegistry` (`src/tool-registry.ts`)
- Holds the management tool schemas (statically defined) and proxied tool schemas (discovered from child)
- Lazy discovery: on first `listTools()` call, probes one child instance for its tool list
- Injects `instanceId` as the first required property into every proxied tool's `inputSchema`

`ToolRouter` (`src/tool-router.ts`)
- Routes `instance_*` and `auth_export_state` calls to management handlers
- Routes all other calls to the target child instance via `instanceId`
- Strips `instanceId` from args before forwarding to the child

`AuthManager` (`src/auth-manager.ts`)
- Calls `browser_run_code` with `page.context().storageState({ path })` to export cookies + localStorage
- Validates `savePath` is within the configured `authDir` (prevents path traversal)
- Default output path: `<authDir>/state-<instanceId>-<timestamp>.json`; chmods to `0o600`

`MultiplexerServer` (`src/multiplexer-server.ts`)
- Wires up the MCP `Server` with `ListToolsRequestSchema` and `CallToolRequestSchema` handlers
- Waits for the MCP handshake (`initialized` notification) before requesting `listRoots()` from the client — uses the first root URI as `workspaceRoot` for DOM state paths
- Discovery is deduplicated: a single `discoveryPromise` is cached; concurrent `listTools()` calls all await the same promise

**Management tools** (defined in `ToolRegistry`):
- `instance_create` — create a new browser instance; options: `headless`, `browser`, `storageState`, `userDataDir`, `cdpEndpoint`, `extension`, `domState`
- `instance_list` — list active instances with status, browser, headless/headed, domState, age
- `instance_close` — close a specific instance by ID
- `instance_close_all` — close all instances (uses `Promise.allSettled` — continues on partial failures)
- `auth_export_state` — export cookies + localStorage to a JSON file

**Proxied tools:** All `@playwright/mcp` tools (`browser_navigate`, `browser_snapshot`, `browser_click`, etc.) are proxied with a required `instanceId` parameter prepended.

### @playwright/mcp Package (`packages/playwright-mcp/`)

Ships plain JS/DTS — no TypeScript source in this package. Re-exports from the `playwright` fork. Built by running `cd ../../playwright && node utils/build/build.js`. The `@playwright/mcp` package version in the multiplexer's `package.json` pins to the local package.

### DOM State Files

After each browser action, `@playwright/mcp` (when the DOM state feature is active) writes files to the workspace:

```
<workspace>/.playwright-mcp/browser-state/
  <instanceId>/               # Per-instance isolation (multiplexer sets PW_DOM_STATE_INSTANCE_ID)
    dom.html                  # Full page DOM — stripped, pretty-printed, ref-annotated
    accessibility-tree.yaml   # Current aria snapshot
    diffs/
      001-navigate-*.diff     # Unified diff after each action
      002-click-*.diff
      ...
```

The workspace root is determined by the MCP client's `roots/list` response. If no workspace root is available, DOM state is silently disabled.

`dom.html` strips: `<head>`, `<script>`, `<style>`, inline `style` attrs, `data-*` attrs, event handlers, generated CSS class names. Keeps: semantic HTML, `id`/`name`/`aria-*`/`role`/`value`, `ref` attribute (injected to match aria tree refs).

Attributes are in canonical order: `id` → `type` → `name` → `role` → `aria-*` → `href` → `value` → `class` → `ref` (always last). Elements with 3+ attributes are pretty-printed one attribute per line for clean diffs.

### CLI Flags

```
--headed / --headless      Default headless mode for new instances
--browser=<name>           Default browser: chrome, chromium, firefox, webkit
--max-instances=<N>        Max concurrent instances (default: 10)
--user-data-dir=<path>     Chrome profile directory to copy auth state from
--profile=<name>           Profile subfolder name (default: Default)
--auth-dir=<path>          Directory for auth state exports (default: ~/.pride-riot/auth)
--cdp-endpoint=<url>       Connect all instances to an existing Chrome via CDP
--extension                Connect via Playwright MCP Bridge browser extension
--executable-path=<path>   Custom browser executable path
```

## Key Conventions and Gotchas

**Module system:** The multiplexer is CommonJS (`"module": "CommonJS"`, `"moduleResolution": "Node"` in tsconfig). Imports do NOT use `.js` extensions. The `cli.ts` uses `require()` directly (via `esModuleInterop`) to call into the CJS output of `@playwright/mcp`.

**@playwright/mcp ships plain JS/DTS** — no TypeScript source. Do not look for `.ts` files in `packages/playwright-mcp/`.

**Browser:** System has `google-chrome-stable` installed. Always use `--browser=chrome`, not `--browser=chromium`. The two use different binary paths.

**`--isolated` flag:** Used when no `userDataDir` is configured — gives each instance a clean ephemeral profile and avoids Chrome profile lock conflicts. The `userDataDir: null` value on `InstanceConfig` explicitly forces `--isolated` regardless of server config (used for probe instances during tool discovery).

**`browser_run_code` eval semantics:** Does not support `const`/`let`/`var` declarations — uses expression eval. Use assignments to pre-existing objects or `await expr` directly.

**Lazy tool discovery:** The multiplexer probes one child instance on first `listTools()` call. If an instance already exists (e.g., created by a prior `instance_create` before `listTools()`), it reuses that instance instead of spawning a new probe. The `discoveryPromise` is cached to deduplicate concurrent discovery.

**Headless via Xvfb, not Chrome headless flag:** `--headless` is never passed to child `@playwright/mcp` processes. Instead, `VirtualDisplayManager` allocates an Xvfb display (`:10`–`:99`) and sets `DISPLAY=:N` in the child's environment. Chrome runs in headed mode on the virtual display. This avoids Chrome's headless-mode rendering differences that trigger bot detection. The `config.json` passed to the child always sets `headless: false` in `launchOptions`.

**Profile copying — Local State:** For Chrome, `Local State` (at the top level of `userDataDir`, above the profile folder) must be copied alongside the profile folder. It contains the key material Chrome uses to decrypt cookies. Without it, cookies from the copied profile will be unreadable.

**MCP SDK types:**
- `inputSchema.properties` type must be `Record<string, object>` not `Record<string, unknown>`
- `CallToolRequestSchema` handler return type requires casting through `unknown` for custom response types: `return result as unknown as Record<string, unknown>`

**Tests:**
- Single-worker (`workers: 1`), non-parallel (`fullyParallel: false`), 60s timeout
- Always run `npx tsc` before `npx playwright test` — tests import from `dist/`
- Tests spawn the multiplexer as a child process via `StdioClientTransport` — full end-to-end MCP protocol over stdio
- Test files: `multiplexer.spec.ts`, `dom-state-env.spec.ts`, `dom-state-multiplexer.spec.ts`, `instance-manager-args.spec.ts`, `close-all-resilience.spec.ts`
- `instance-manager-args.spec.ts` tests `buildArgs()` as a unit test by importing from `dist/src/instance-manager.js` directly and casting to access the private method

**`instance_close_all` resilience:** Uses `Promise.allSettled()` so all instances are attempted even if individual closes fail. Failures are logged to stderr.

**`auth_export_state` path security:** `savePath` must resolve to a path within `authDir`. The check uses `path.resolve()` on both sides and verifies with `startsWith(authDirResolved + path.sep)` — the `path.sep` suffix prevents prefix confusion (e.g. `/auth-evil` passing against `/auth`).

**`MultiplexerServer.connect()` ordering:** `server.connect()` starts I/O but the MCP handshake is async. The server waits for the `initialized` notification before calling `server.listRoots()` — calling `listRoots()` before the handshake completes will fail.
