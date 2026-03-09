# Architecture Report: Concurrent Browser Instances with Shared Authentication

**Date**: 2026-02-11
**Status**: Research / Proposal
**Scope**: concurrent-browser-mcp fork for pride-riot job application automation

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current State Analysis](#2-current-state-analysis)
3. [Options for Sharing Authentication State](#3-options-for-sharing-authentication-state)
4. [Recommended Approach](#4-recommended-approach)
5. [API Design](#5-api-design)
6. [Risk Assessment](#6-risk-assessment)
7. [Appendix: Platform-Specific Authentication Patterns](#appendix-platform-specific-authentication-patterns)

---

## 1. Problem Statement

The pride-riot project requires automated job application submission across multiple platforms (LinkedIn, Greenhouse, Lever, Workday, etc.) with the ability to process multiple applications in parallel. Two existing tools address parts of this problem but not the whole:

**browser-use** provides a single-browser-session model with tab-based navigation. All tabs share one `BrowserContext` and therefore share cookies, localStorage, and session state. Authentication happens once and persists. However, this model is fundamentally sequential -- tabs within a single Playwright context share a single event loop for navigation, and browser-use's MCP server tracks exactly one active `BrowserSession` at a time.

**concurrent-browser-mcp** provides a multi-instance model where each instance is a fully isolated browser (separate `Browser` process, separate `BrowserContext`, separate `Page`). This achieves true parallelism -- each instance can navigate independently and simultaneously. However, every instance starts with a blank session. There is no mechanism to share or pre-populate authentication state.

**The gap**: We need instances that run in parallel but inherit authenticated sessions from job platforms. Re-authenticating per instance is untenable because:

- LinkedIn, Workday, and Greenhouse impose login rate limits and may trigger account lockouts.
- Many platforms require 2FA/MFA, which cannot be automated without user intervention.
- OAuth callback flows are stateful and tied to a specific browser session.
- Session tokens have varying TTLs; some expire within minutes of inactivity.

---

## 2. Current State Analysis

### 2.1 concurrent-browser-mcp Architecture

The server is structured around four source files:

| File | Responsibility |
|------|---------------|
| `src/browser-manager.ts` | Browser lifecycle: launch, track, cleanup instances |
| `src/tools.ts` | MCP tool definitions and execution dispatch |
| `src/types.ts` | TypeScript interfaces for all data structures |
| `src/server.ts` | MCP server setup, request routing, default config |

**Instance Creation Flow** (`BrowserManager.createInstance`):

```
1. Check maxInstances limit (default 20)
2. Merge default config with per-instance overrides
3. Call launchBrowser(config) --> spawns new Browser process via Playwright
4. Call browser.newContext(contextOptions) --> creates isolated BrowserContext
5. Call context.newPage() --> creates initial Page
6. Assign UUID, store in instances Map
```

Key observations:

- **Each instance gets its own `Browser` process.** Line 175: `const browser = await this.launchBrowser(config)`. This is `chromium.launch()`, not `browser.newContext()`. Every instance is a separate OS process.

- **Each instance gets its own `BrowserContext`.** Line 191: `const context = await browser.newContext(contextOptions)`. The context is created fresh with no `storageState`.

- **The `BrowserConfig.contextOptions` interface already includes a `storageState` field** (types.ts line 36), but it is never populated by the tool interface and there is no mechanism to provide it at creation time through the MCP tool schema.

- **No cookie/state export mechanism exists.** There is no tool to extract `storageState` from a running instance, nor to inject cookies into one.

- **Instance isolation is total.** The `BrowserInstance` type holds `browser`, `context`, and `page` as independent objects. No sharing occurs between instances.

**Playwright APIs in Use**:

| API | Where Used | Purpose |
|-----|-----------|---------|
| `chromium.launch(options)` | `launchBrowser()` | Spawns isolated browser process |
| `browser.newContext(options)` | `createInstance()` | Creates isolated browsing context |
| `context.newPage()` | `createInstance()` | Creates initial page in context |
| `page.goto()`, `.click()`, `.fill()`, etc. | Various tool methods | Page automation |

**What is NOT used** (but is available in Playwright):

| API | Purpose | Relevance |
|-----|---------|-----------|
| `browser.newContext({ storageState })` | Pre-populate context with cookies/storage | Direct auth injection |
| `context.storageState()` | Export cookies + localStorage as JSON | Auth state capture |
| `context.addCookies()` | Inject cookies into existing context | Dynamic auth injection |
| `context.cookies()` | Read current cookies from context | Auth state inspection |
| `chromium.launchPersistentContext(userDataDir)` | Launch with on-disk profile | Persistent sessions |

### 2.2 browser-use Architecture (for Comparison)

browser-use takes a fundamentally different approach:

- **BrowserProfile** (`browser_use/browser/profile.py`) is a Pydantic model that encapsulates all browser configuration including `user_data_dir`, `storage_state`, proxy settings, extensions, and display configuration.

- **BrowserSession** (`browser_use/browser/session.py`) manages a single browser instance via CDP (Chrome DevTools Protocol), not Playwright's high-level API. It launches Chrome as a subprocess and connects over `--remote-debugging-port`.

- **Persistent profiles**: By default, browser-use uses `~/.config/browseruse/profiles/default` as `user_data_dir`. This means cookies survive between server restarts. The `_copy_profile()` method on `BrowserProfile` copies the profile to a temp directory before launching, which avoids corrupting the original profile while still inheriting its cookies.

- **StorageStateWatchdog** (`browser_use/browser/watchdogs/storage_state_watchdog.py`) monitors cookie changes via CDP and periodically saves them to a JSON file. On browser startup, it loads cookies from the file back into the browser. This provides a file-based persistence/sharing mechanism.

- **Tab model**: browser-use exposes `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab` tools. All tabs share one context. Authentication done in one tab is visible in all others.

- **Single session**: The MCP server (`browser_use/mcp/server.py`) tracks exactly one `self.browser_session` and one `self.tools` instance. The `_init_browser_session()` method is called lazily on first tool use. There is no multi-session concurrency.

**Key takeaway from browser-use**: The `storage_state` + `user_data_dir` pattern works well for auth persistence within a single session, and the `StorageStateWatchdog` demonstrates a working pattern for cookie export/import via CDP. However, browser-use does not solve concurrency.

---

## 3. Options for Sharing Authentication State

### 3.1 Option A: `storageState` Injection at Context Creation

**Mechanism**: Use Playwright's `browser.newContext({ storageState })` to pre-populate new contexts with cookies and localStorage from an authenticated session.

**Flow**:
```
1. Create "auth instance" --> manually login or load saved state
2. Export storageState from auth instance: context.storageState()
3. Create worker instances with: browser.newContext({ storageState: exportedState })
4. Worker instances start with all cookies pre-loaded
```

**Advantages**:
- Native Playwright API; well-documented, well-tested.
- `storageState` is a simple JSON blob containing cookies and localStorage per origin.
- Each worker still gets its own isolated `BrowserContext`, so DOM state, navigation history, and JavaScript globals are independent.
- Cookies from multiple platforms can be combined into a single `storageState` JSON.
- No shared mutable state between workers -- each gets a snapshot.

**Disadvantages**:
- **Point-in-time snapshot**: If the auth instance refreshes a token or gets a new session cookie after export, workers do not see the update. They have stale cookies.
- **No session refresh propagation**: If a worker's cookies expire mid-session, there is no mechanism to get fresh ones without re-exporting from the auth instance.
- **localStorage limitations**: Playwright's `storageState` captures `localStorage` but NOT `sessionStorage` or IndexedDB. Some platforms store auth tokens in IndexedDB (Workday does this).
- **One-shot**: Worker contexts are created with the state frozen at export time. Cannot update cookies on a running context via `storageState` (must use `addCookies` for that).

**Complexity**: Low. Requires adding ~50 lines to `BrowserManager` and two new MCP tools.

### 3.2 Option B: Dynamic Cookie Import/Export Between Instances

**Mechanism**: Add tools to export cookies from one instance and inject them into another using `context.cookies()` and `context.addCookies()`.

**Flow**:
```
1. Create "auth instance" --> manually login
2. Export cookies: context.cookies([url1, url2, ...])
3. Inject cookies into worker instance: context.addCookies(cookies)
4. Worker navigates to platform --> already authenticated
5. Periodically re-export from auth instance and re-inject into workers
```

**Advantages**:
- Cookies can be injected into an *already running* context, unlike `storageState` which is only applied at creation.
- Enables a "cookie refresh" pattern: auth instance can be polled periodically and fresh cookies pushed to workers.
- Selective: can export/inject only cookies for specific domains.
- Composable with Option A (use storageState for initial load, addCookies for updates).

**Disadvantages**:
- Does NOT transfer `localStorage` or `sessionStorage`. `addCookies` only works with cookies.
- Injecting cookies after page load may not take effect until the page is refreshed -- sites that check auth tokens from cookies in JavaScript on initial load will not re-read cookies that were injected after.
- Race condition risk: if two workers export/inject simultaneously, they could overwrite each other's cookies on the auth instance (though auth instance cookies should be read-only for workers).
- `context.cookies()` returns cookies for the current page's domain by default, requiring explicit URL filtering to get cross-domain cookies.

**Complexity**: Low-Medium. Requires `context.cookies()` and `context.addCookies()` wrappers plus domain filtering logic.

### 3.3 Option C: Persistent Browser Profiles (`user_data_dir`)

**Mechanism**: Use Playwright's `chromium.launchPersistentContext(userDataDir)` instead of the current `chromium.launch()` + `browser.newContext()` pattern. The `user_data_dir` points to an on-disk Chrome profile that contains all cookies, localStorage, IndexedDB, Service Workers, cache, and other state.

**Flow**:
```
1. Maintain a set of authenticated Chrome profiles on disk (e.g., ~/.pride-riot/profiles/linkedin/)
2. When creating a worker, copy the profile to a temp directory (browser-use pattern)
3. Launch with launchPersistentContext(tempProfileDir)
4. Worker starts with full browser state from the profile
```

**Advantages**:
- **Complete state**: captures everything -- cookies, localStorage, sessionStorage, IndexedDB, Service Workers, cached credentials, HTTP cache. This is the most faithful reproduction of an authenticated browser session.
- Survives server restarts. Profiles persist on disk.
- browser-use already demonstrates this pattern with `_copy_profile()`.
- No need for explicit export/import -- the profile IS the state.

**Disadvantages**:
- **Chromium lock file**: A `user_data_dir` cannot be opened by two browser instances simultaneously. Chrome writes a `SingletonLock` file. This is why browser-use copies the profile to a temp dir before launching.
- **Copy overhead**: Copying an entire Chrome profile can be 50-500MB+ depending on cache. For high-concurrency (10+ workers), this is significant I/O.
- **Staleness**: The copy is a point-in-time snapshot, same as Option A. If the auth session refreshes tokens after the copy, workers have stale state.
- **API change**: `launchPersistentContext()` returns a `BrowserContext` directly, not a `Browser`. This changes the object model -- there is no separate `Browser` object. The current `BrowserInstance` type stores `browser`, `context`, and `page` as separate fields. With persistent context, `browser` would be `null` or the persistent context itself.
- **No Firefox/WebKit support**: `launchPersistentContext` has limited support outside Chromium.
- **Profile corruption risk**: If a worker modifies the profile (writes cookies, updates IndexedDB) and the temp dir is not properly isolated, corruption can propagate.

**Complexity**: Medium-High. Requires refactoring `BrowserManager.launchBrowser()` and `createInstance()` to support two launch modes (standard vs. persistent), handling the different object model, and adding profile copy logic.

### 3.4 Option D: "Parent Context" Model (Context Forking)

**Mechanism**: Launch a single `Browser` process and create multiple `BrowserContext` instances within it, each pre-populated with the same `storageState`. This avoids spawning multiple browser processes while still maintaining context isolation.

**Flow**:
```
1. Launch ONE browser process: chromium.launch()
2. Create "auth context": browser.newContext() --> login manually
3. Export: authContext.storageState()
4. Create worker contexts: browser.newContext({ storageState: authState })
5. Each worker context gets its own Page
```

**Advantages**:
- **Lower resource usage**: One browser process instead of N. Each `BrowserContext` is lightweight compared to a full browser process (~20-50MB vs ~150-300MB).
- Contexts are still fully isolated (separate cookie jars, separate localStorage, separate JavaScript globals).
- Enables a "pool" pattern: pre-create N contexts from the same auth state, hand them out as workers request them.
- Contexts within the same browser can theoretically share GPU process and renderer resources.

**Disadvantages**:
- **Concurrency concern**: Multiple contexts in one browser process share the same main process thread for browser-level operations. While page-level JavaScript runs in separate renderer processes, operations like `newContext()`, network interception, and CDP commands are serialized through the browser's main thread. Under heavy load (10+ active contexts), this can create contention.
- **Process crash scope**: If the browser process crashes, ALL contexts go down. With separate browser processes (current model), a crash in one instance does not affect others.
- **storageState is still point-in-time**: Same staleness problem as Options A and C.
- **Requires architectural change**: The current model assumes one Browser per instance. Introducing shared browsers changes the lifecycle management significantly -- when do you close the shared browser? What happens if one worker closes its context?

**Complexity**: Medium. Requires a new "browser pool" concept in BrowserManager, separating the Browser lifecycle from the Context lifecycle.

### 3.5 Option E: Proxy-Based Session Sharing

**Mechanism**: Run an HTTP proxy that intercepts requests and injects authentication headers/cookies from a central store.

**Flow**:
```
1. Maintain a cookie store service (e.g., Redis or in-memory Map)
2. Run an HTTP proxy (e.g., mitmproxy or custom Node.js proxy)
3. Configure all browser instances to use the proxy
4. Proxy intercepts outgoing requests and adds auth cookies
5. Proxy intercepts incoming responses and captures Set-Cookie headers
```

**Advantages**:
- Completely transparent to the browser instances. No changes to context creation.
- Centralizes auth state management -- all workers see the same cookies.
- Can handle cookie refresh automatically (proxy captures new cookies from any worker and makes them available to all).

**Disadvantages**:
- **Enormous complexity**: Building a reliable HTTP proxy that correctly handles cookies, HSTS, TLS certificates, HTTP/2, WebSocket connections, and CORS is a multi-month project.
- **Performance overhead**: Every request goes through an extra hop. For interactive automation (screenshots, DOM manipulation), latency matters.
- **HTTPS interception**: Requires installing a custom CA certificate in the browser, which many sites detect as a MITM indicator.
- **Cookie domain isolation breaks**: Browsers enforce cookie domain rules. A proxy injecting cookies for `linkedin.com` on a request to `greenhouse.io` would be invalid. The proxy must be domain-aware.
- **Overkill**: This solves a broader problem than what we need. We do not need real-time cross-instance cookie synchronization -- we need initial auth state seeding.

**Complexity**: Very High. Not recommended.

---

## 4. Recommended Approach

### 4.1 Primary Recommendation: Hybrid A+B (storageState + addCookies)

The recommended approach combines **Option A (storageState injection at context creation)** with **Option B (dynamic cookie import/export)** and borrows the **file-based persistence pattern from browser-use's StorageStateWatchdog**.

**Why this combination**:

1. **storageState at creation** handles the common case: seed a worker with full auth state (cookies + localStorage) at launch time. This covers 90% of the use case -- most job platform sessions last 15-60 minutes, and each application takes 2-10 minutes.

2. **addCookies for mid-session refresh** handles the edge case: if a worker's session expires or needs updated tokens, we can re-export from the auth instance and inject fresh cookies without destroying and recreating the worker's context.

3. **File-based persistence** decouples auth acquisition from worker creation. An operator can authenticate manually in a headed browser, export state to `~/.pride-riot/auth/linkedin.json`, and worker instances can load this state even across server restarts.

4. **Low implementation complexity**. All required Playwright APIs (`storageState`, `addCookies`, `cookies`) are stable and well-documented. The changes to concurrent-browser-mcp are additive, not refactoring.

### 4.2 Architecture

```
                               +---------------------------+
                               |   Auth State Storage      |
                               |   (File System)           |
                               |                           |
                               |  ~/.pride-riot/auth/      |
                               |    linkedin.json          |
                               |    greenhouse.json        |
                               |    workday.json           |
                               |    combined.json          |
                               +--------+--+--+------------+
                                        ^  ^  ^
                         export_state    |  |  | load on create
                                 +------+  |  +-------+
                                 |         |          |
                          +------+----+ +--+-------+ ++----------+
                          | Auth      | | Worker   | | Worker    |
                          | Instance  | | Instance | | Instance  |
                          | (headed)  | | #1       | | #2        |
                          |           | |          | |           |
                          | LinkedIn  | | Apply to | | Apply to  |
                          | logged in | | Job A    | | Job B     |
                          +-----------+ +----------+ +-----------+
                                 |           ^             ^
                                 |           |             |
                                 +-----------+-------------+
                                   addCookies (on demand,
                                   if session refresh needed)
```

### 4.3 Implementation Strategy

The implementation adds three layers:

**Layer 1: Auth State File Management**
- A new `AuthStateManager` class that handles reading/writing storageState JSON files.
- Supports per-platform state files and a combined state file.
- Stores files in a configurable directory (default: `~/.pride-riot/auth/`).

**Layer 2: Instance Creation with Auth State**
- Extend `BrowserManager.createInstance()` to accept a `storageState` parameter.
- Pass `storageState` into `browser.newContext({ storageState })`.
- Support both file path (string) and inline JSON (object) for `storageState`.

**Layer 3: Runtime Cookie Operations**
- New MCP tools for exporting/importing cookies between instances.
- Export: `context.storageState()` or `context.cookies()`.
- Import: `context.addCookies()`.

### 4.4 Why NOT Persistent Contexts (Option C)?

While browser-use's persistent profile approach is tempting because it captures complete state, it introduces significant downsides for a concurrent system:

1. **The `SingletonLock` problem is fundamental.** Copying profiles is expensive (100-500ms per instance for a 200MB profile) and creates stale snapshots -- the same problem `storageState` has, but with higher overhead.

2. **`launchPersistentContext()` changes the Playwright object model.** It returns `BrowserContext` directly instead of `Browser`, which means the entire `BrowserInstance` type and all lifecycle management code must be refactored. The `storageState` approach works within the existing architecture.

3. **Profile corruption is a real risk.** Chrome profiles contain SQLite databases, LevelDB stores, and other file formats that can corrupt if improperly copied or if multiple instances modify them simultaneously.

4. **We do not need IndexedDB or Service Worker state.** The job platforms we target (LinkedIn, Greenhouse, Lever, Workday) primarily use cookies and localStorage for auth. `storageState` captures both of these. IndexedDB usage for auth is rare in these platforms and can be handled with `browser_evaluate` if encountered.

### 4.5 Why NOT Shared Browser Process (Option D)?

The "parent context" model (one browser, multiple contexts) trades resource efficiency for blast-radius risk. A single browser crash kills all workers. For a job application system where each application may take 5-10 minutes and represents real work, losing all in-progress applications due to one crash is unacceptable. The current model of separate browser processes per instance provides better fault isolation and is worth the extra memory cost.

---

## 5. API Design

### 5.1 New MCP Tools

#### `browser_create_instance` (Modified)

Add `storageState` and `storageStatePath` parameters to the existing tool:

```typescript
{
  name: 'browser_create_instance',
  inputSchema: {
    type: 'object',
    properties: {
      // ... existing properties (browserType, headless, viewport, etc.) ...
      storageState: {
        type: 'object',
        description: 'Inline storage state object (cookies + origins) to pre-populate the context. Mutually exclusive with storageStatePath.',
        properties: {
          cookies: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
                domain: { type: 'string' },
                path: { type: 'string' },
                expires: { type: 'number' },
                httpOnly: { type: 'boolean' },
                secure: { type: 'boolean' },
                sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] }
              },
              required: ['name', 'value', 'domain', 'path']
            }
          },
          origins: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                origin: { type: 'string' },
                localStorage: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      value: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      storageStatePath: {
        type: 'string',
        description: 'File path to a storageState JSON file. Mutually exclusive with storageState.'
      }
    }
  }
}
```

#### `browser_export_storage_state` (New)

```typescript
{
  name: 'browser_export_storage_state',
  description: 'Export cookies and localStorage from a browser instance as a storageState JSON object. Optionally save to a file.',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: {
        type: 'string',
        description: 'Instance ID to export from'
      },
      savePath: {
        type: 'string',
        description: 'Optional file path to save the storage state JSON'
      }
    },
    required: ['instanceId']
  }
}
```

**Implementation**:
```typescript
async exportStorageState(instanceId: string, savePath?: string): Promise<ToolResult> {
  const instance = this.browserManager.getInstance(instanceId);
  if (!instance) {
    return { success: false, error: `Instance ${instanceId} not found` };
  }

  const state = await instance.context.storageState();

  if (savePath) {
    const fs = await import('fs/promises');
    await fs.writeFile(savePath, JSON.stringify(state, null, 2));
  }

  return {
    success: true,
    data: {
      cookiesCount: state.cookies.length,
      originsCount: state.origins.length,
      savePath: savePath || null,
      // Include the state itself for inline use
      storageState: state
    },
    instanceId
  };
}
```

#### `browser_import_cookies` (New)

```typescript
{
  name: 'browser_import_cookies',
  description: 'Import cookies into an existing browser instance. Use this to refresh auth state on a running instance without recreating it.',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: {
        type: 'string',
        description: 'Instance ID to import cookies into'
      },
      cookies: {
        type: 'array',
        description: 'Array of cookie objects to import',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: { type: 'string' },
            domain: { type: 'string' },
            path: { type: 'string' },
            url: { type: 'string' },
            expires: { type: 'number' },
            httpOnly: { type: 'boolean' },
            secure: { type: 'boolean' },
            sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] }
          },
          required: ['name', 'value']
        }
      },
      fromInstanceId: {
        type: 'string',
        description: 'Alternative: copy cookies from another instance instead of providing them inline'
      },
      fromPath: {
        type: 'string',
        description: 'Alternative: load cookies from a storageState JSON file'
      },
      domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: only import cookies matching these domains'
      }
    },
    required: ['instanceId']
  }
}
```

#### `browser_get_cookies` (New)

```typescript
{
  name: 'browser_get_cookies',
  description: 'Get cookies from a browser instance, optionally filtered by URLs.',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: {
        type: 'string',
        description: 'Instance ID'
      },
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: only return cookies for these URLs'
      }
    },
    required: ['instanceId']
  }
}
```

### 5.2 New Type Definitions

```typescript
// types.ts additions

export interface StorageState {
  cookies: StorageStateCookie[];
  origins: StorageStateOrigin[];
}

export interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface StorageStateOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

// Extend BrowserConfig
export interface BrowserConfig {
  // ... existing fields ...
  contextOptions?: {
    ignoreHTTPSErrors?: boolean;
    bypassCSP?: boolean;
    storageState?: string | StorageState;  // <-- now typed
  };
}
```

### 5.3 Workflow Example

Here is how a pride-riot agent would use these tools in practice:

```
Step 1: Setup Phase (once, possibly manual)
  --> browser_create_instance({ headless: false, metadata: { name: "auth-linkedin" } })
  --> browser_navigate({ instanceId: "auth-1", url: "https://linkedin.com/login" })
  --> [Agent or human logs in, handles 2FA]
  --> browser_export_storage_state({ instanceId: "auth-1", savePath: "~/.pride-riot/auth/linkedin.json" })

Step 2: Worker Phase (parallel)
  --> browser_create_instance({
        storageStatePath: "~/.pride-riot/auth/linkedin.json",
        metadata: { name: "worker-job-a" }
      })
  --> browser_create_instance({
        storageStatePath: "~/.pride-riot/auth/linkedin.json",
        metadata: { name: "worker-job-b" }
      })
  --> browser_navigate({ instanceId: "worker-1", url: "https://linkedin.com/jobs/apply/12345" })
  --> browser_navigate({ instanceId: "worker-2", url: "https://linkedin.com/jobs/apply/67890" })
  --> [Both workers are authenticated, apply in parallel]

Step 3: Session Refresh (if needed)
  --> browser_export_storage_state({ instanceId: "auth-1" })
  --> browser_import_cookies({
        instanceId: "worker-1",
        fromInstanceId: "auth-1",
        domains: ["linkedin.com", ".linkedin.com"]
      })
```

---

## 6. Risk Assessment

### 6.1 Session Conflicts and Race Conditions

**Risk: Concurrent session invalidation**
Some platforms (notably LinkedIn) enforce "single active session" policies. If multiple instances present the same session cookie simultaneously, the platform may detect this as anomalous and invalidate all sessions.

**Mitigation**: Monitor for 401/403 responses across instances. If a session is invalidated, pause all workers for that platform, re-authenticate on the auth instance, and re-distribute cookies. Consider adding a `browser_on_auth_failure` event or callback mechanism.

**Risk: Cookie write conflicts**
If two workers both modify cookies for the same domain (e.g., both trigger a CSRF token refresh), they will have divergent cookie states. The next export from either will not represent the "canonical" state.

**Mitigation**: Workers should be treated as consumers of auth state, not producers. The auth instance is the single source of truth. Workers should not be used as the source for `browser_export_storage_state` for auth cookies. Application-specific cookies (like CSRF tokens or form state) are per-worker and should not be shared.

### 6.2 Cookie Expiry and TTL

**Risk: Session cookies expire during worker operation**

| Platform | Typical Session TTL | Token Refresh Pattern |
|----------|--------------------|-----------------------|
| LinkedIn | 24h (remember me) / 1h (default) | JSESSIONID refresh on activity |
| Greenhouse | 30-60 min | Rails session cookie, refreshed on each request |
| Lever | 30-60 min | JWT in cookie, refresh token flow |
| Workday | 15-30 min | Short-lived, frequent refresh |
| Ashby | 60 min | Standard session cookie |

**Mitigation**: Implement a "session health check" pattern. Before starting an application flow, have the worker navigate to a known authenticated page (e.g., LinkedIn dashboard) and verify it loads correctly. If it redirects to login, trigger a cookie refresh from the auth instance. For Workday specifically, session timeout is so aggressive that workers should minimize idle time.

### 6.3 Platform-Specific Detection Risks

**Risk: Bot detection from parallel access patterns**
Job platforms use various signals to detect automation:
- Multiple sessions from the same IP accessing different job postings at the same time
- Browser fingerprinting (Playwright's default fingerprint is well-known)
- Request timing patterns (automated clicks are faster and more regular than human ones)
- `navigator.webdriver` flag (Playwright sets this by default)

**Mitigation**:
- Use `chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] })` to suppress `navigator.webdriver`. The current codebase only does this for headless mode.
- Limit parallelism per platform. Do not run more than 2-3 concurrent workers against the same platform from the same IP.
- Add random delays between actions (the tools already support `delay` parameters on click/type).
- Consider rotating user agents across instances.
- The proxy detection code already supports configured proxies; use different proxies per instance for higher-volume work.

### 6.4 localStorage Limitations

**Risk: storageState does not capture sessionStorage or IndexedDB**

Playwright's `context.storageState()` exports cookies and localStorage. It does NOT capture:
- `sessionStorage` (by design -- it is per-tab and not shareable)
- IndexedDB
- Cache Storage (Service Worker caches)
- WebSQL (deprecated but some legacy ATS systems use it)

**Mitigation**: For most job platforms, cookies + localStorage covers auth state. If a platform is found to store critical auth tokens in IndexedDB (which would be visible during debugging), use `browser_evaluate` to extract and inject them:

```javascript
// Export IndexedDB auth data
const db = await indexedDB.open('auth_db');
const tx = db.transaction('tokens', 'readonly');
const store = tx.objectStore('tokens');
const authToken = await store.get('access_token');
return authToken;
```

This should be treated as a per-platform workaround, not a general mechanism.

### 6.5 File System Security

**Risk: storageState files contain sensitive session tokens**

The exported JSON files contain raw cookie values, which are bearer tokens. Anyone with access to these files can impersonate the user's session.

**Mitigation**:
- Store files with restrictive permissions (0600).
- Use the `~/.pride-riot/auth/` directory with appropriate ownership.
- Do NOT commit auth state files to version control.
- Consider encrypting at rest (though this adds complexity for marginal benefit since the attacker model is "other processes on the same machine").
- Implement automatic cleanup of expired state files.

### 6.6 Memory and Resource Scaling

**Risk: Each browser instance consumes 150-300MB of RAM**

With the recommended approach (separate browser processes), 10 concurrent workers could consume 1.5-3GB of RAM.

**Mitigation**: The existing `maxInstances` (default 20) and `instanceTimeout` (default 30 min) configuration parameters provide basic guardrails. For pride-riot, consider:
- Setting `maxInstances` to 5-8 for a typical developer machine.
- Reducing `instanceTimeout` to 10-15 minutes.
- Implementing a worker pool pattern where instances are reused across applications rather than created/destroyed for each one.
- Using headless mode for workers (auth instance can be headed for manual login).

---

## Appendix: Platform-Specific Authentication Patterns

### LinkedIn
- **Auth mechanism**: Session cookie (`JSESSIONID`, `li_at`, `lidc`)
- **Token storage**: Cookies only. `li_at` is the primary auth token.
- **MFA**: SMS or authenticator app. Triggered on new device/location.
- **Session behavior**: `li_at` is long-lived (24h+ with "remember me"). Worker instances with this cookie can operate independently.
- **Detection risk**: Medium. LinkedIn has moderate bot detection. Rate limit on API calls and page loads.

### Greenhouse (job boards)
- **Auth mechanism**: Rails session cookie (`_session_id`) on the employer side. Candidate-facing pages may use OAuth or email-based auth.
- **Token storage**: Cookie + CSRF token in localStorage/meta tag.
- **Session behavior**: Standard Rails session. Workers need both the session cookie and a valid CSRF token. CSRF token changes on each page load but is domain-specific, not session-specific.
- **Detection risk**: Low. Greenhouse boards are designed for high traffic.

### Lever
- **Auth mechanism**: JWT in cookie + refresh token.
- **Token storage**: Cookies (httpOnly).
- **Session behavior**: JWT expires frequently; refresh token extends the session. Workers may need periodic cookie refresh.
- **Detection risk**: Low-Medium.

### Workday
- **Auth mechanism**: Complex multi-cookie system (`PLAY_SESSION`, `wd-browser-id`, various `AWSALB` load balancer cookies).
- **Token storage**: Cookies + IndexedDB (some Workday instances use IndexedDB for token caching).
- **Session behavior**: Short-lived sessions (15-30 min). Aggressive timeout. Workers must complete quickly.
- **Detection risk**: Medium-High. Workday has fingerprinting and rate limiting.
- **Special consideration**: Workday uses client-side rendered SPAs heavily. `storageState` may not capture all required state. May need `browser_evaluate` to transfer IndexedDB auth tokens.

### Ashby
- **Auth mechanism**: Standard session cookie.
- **Token storage**: Cookies.
- **Session behavior**: Standard 60-min timeout.
- **Detection risk**: Low.

---

## Summary

The recommended approach is **Hybrid A+B**: `storageState` injection at context creation time combined with `addCookies` for mid-session refresh and file-based persistence for cross-restart auth state. This approach:

- Works within the existing concurrent-browser-mcp architecture without refactoring.
- Leverages stable, well-documented Playwright APIs.
- Provides the right balance of auth sharing and instance isolation.
- Keeps implementation complexity low (estimated 3-5 tickets, each completable in a single session).
- Handles the primary job platforms (LinkedIn, Greenhouse, Lever, Workday) effectively.

The main risks are session invalidation from parallel access, cookie expiry under load, and platform-specific bot detection. These are mitigated through rate limiting, session health checks, and the auth-instance-as-source-of-truth pattern.
