# TICKET-015: Multiplexer support -- pass DOM state env vars to child instances

## Metadata
| Field | Value |
|-------|-------|
| Status | COMPLETED |
| Priority | P1-High |
| Effort | M (1-4hr) |
| Assignee | Claude |

## Description
Modify the multiplexer's `InstanceManager` to pass `PW_DOM_STATE_INSTANCE_ID` and `PW_DOM_STATE_WORKSPACE` environment variables to child Playwright MCP processes at spawn time. This enables per-instance file isolation: each child writes its DOM state files to a separate subdirectory under `.playwright-mcp/browser-state/<instanceId>/`.

The multiplexer must also obtain the workspace root from the AI client's MCP initialization (which provides `roots` in the initialize request) and store it for use when spawning children.

## Technical Approach
- **Architecture Layer**: Backend (multiplexer orchestration)
- **Design Patterns**: Environment variable injection, parent-child process communication
- **Implementation Strategy**:
  1. Modify `InstanceManager` to accept and store the workspace root
  2. In the `create()` method, add `PW_DOM_STATE_INSTANCE_ID` (set to the instance ID) and `PW_DOM_STATE_WORKSPACE` (set to the workspace root) to the env block of `StdioClientTransport`
  3. The multiplexer server handler must extract the workspace root from the client's roots during initialization and pass it to `InstanceManager`

## Files Affected
- `playwright-mcp/packages/playwright-mcp-multiplexer/src/instance-manager.ts` - Modify - Add env vars to child process spawn
- `playwright-mcp/packages/playwright-mcp-multiplexer/src/types.ts` - Modify - Add `workspaceRoot` to `MultiplexerConfig` if needed

## Dependencies
- **Prerequisite Tickets**: TICKET-005 (DomState must read these env vars)
- **External Dependencies**: None
- **Potential Blockers**: The multiplexer's MCP server handler must have access to client roots; verify the initialization flow provides this

## Acceptance Criteria
- [x] Child processes receive `PW_DOM_STATE_INSTANCE_ID` env var set to their instance ID (e.g., `inst-1`)
- [x] Child processes receive `PW_DOM_STATE_WORKSPACE` env var set to the workspace root path
- [x] Multiple child instances write to separate directories: `.playwright-mcp/browser-state/inst-1/`, `.playwright-mcp/browser-state/inst-2/`, etc.
- [x] No cross-contamination between instance directories
- [x] If no workspace root is available, env vars are not set (children fall through to their own root detection or disable DOM state)
- [x] Existing multiplexer functionality is not affected (all existing tests pass)
- [x] The env vars are set at spawn time, not on every tool call

## Testing Requirements
- **Unit Tests**:
  - Test that `create()` includes DOM state env vars in the transport config
  - Test that each instance gets a unique `PW_DOM_STATE_INSTANCE_ID`
  - Test that `PW_DOM_STATE_WORKSPACE` matches the stored workspace root
- **Integration Tests**:
  - Spawn two instances via multiplexer, navigate both to different pages, verify separate `dom.html` files
  - Verify instance-specific file paths in response (`.playwright-mcp/browser-state/inst-1/dom.html`)
- **Manual Testing**: Start multiplexer with two browser instances, verify file isolation
- **Coverage Target**: 80%

## Implementation Notes
The change to `instance-manager.ts` is in the `create()` method, in the `StdioClientTransport` constructor:

```typescript
const transport = new StdioClientTransport({
  command: 'node',
  args: [this.config.cliPath, ...args],
  stderr: 'pipe',
  env: {
    ...process.env,
    DEBUG: process.env.DEBUG ?? '',
    PW_DOM_STATE_INSTANCE_ID: id,                    // <-- NEW
    PW_DOM_STATE_WORKSPACE: this.workspaceRoot ?? '', // <-- NEW
  },
});
```

The `workspaceRoot` needs to be stored on the `InstanceManager`. Options:
1. Add it to `MultiplexerConfig` and set it during initialization
2. Pass it as a parameter to `create()` from the MCP server handler
3. Add a `setWorkspaceRoot()` method called during MCP initialization

The cleanest approach is option 1 or adding a `setWorkspaceRoot()` method that the MCP server handler calls after receiving client roots:

```typescript
// In the MCP server handler's initialize callback:
const firstRoot = clientInfo.roots[0];
if (firstRoot) {
  instanceManager.setWorkspaceRoot(fileURLToPath(new URL(firstRoot.uri)));
}
```

The multiplexer server handler needs to be examined to find the right integration point. Look for where `initialize` or `roots/list` is handled.

## References
- Spec Section: 8.3 (File Path Resolution -- Multiplexer integration)
- Spec Section: 13, Test Cases 19-22 (multiplexer tests)
- Related Tickets: TICKET-005 (DomState reads env vars), TICKET-016 (multiplexer tests)
