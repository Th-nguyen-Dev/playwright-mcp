# TICKET-017: Update agent instructions for DOM state file usage

## Metadata
| Field | Value |
|-------|-------|
| Status | COMPLETED |
| Priority | P2-Medium |
| Effort | M (1-4hr) |
| Assignee | Unassigned |

## Description
Update the AI agent's system prompt / instructions (the submitter or internet agent that drives the browser) to inform it about DOM state files. The agent needs to know:

1. After every browser action, a "Browser State" section in the response provides file paths to `dom.html`, `accessibility-tree.yaml`, and a diff file.
2. How to use `Read` to see the full page DOM or a specific section.
3. How to use `Grep` with a ref to find context around a specific element.
4. How to read diff files to see what changed after an action.
5. When to use DOM files vs the in-context aria tree (aria tree for quick ref lookup, DOM files for detailed context).
6. For multiplexer instances, files are per-instance under `.playwright-mcp/browser-state/<instanceId>/`.

Without this instruction update, the AI agent will not know the DOM state files exist and will not use them, negating the entire feature's value.

## Technical Approach
- **Architecture Layer**: Documentation / Agent configuration
- **Design Patterns**: N/A
- **Implementation Strategy**:
  1. Identify the system prompt / instruction file for the browser-driving agent
  2. Add a section describing DOM state files and their usage
  3. Include concrete examples of `Read` and `Grep` commands
  4. Explain the relationship between refs in the aria tree and refs in `dom.html`

## Files Affected
- Agent system prompt / instruction file (location TBD -- may be in the pride-riot project, CLAUDE.md, or similar configuration file)

## Dependencies
- **Prerequisite Tickets**: TICKET-008 (core implementation must be working)
- **External Dependencies**: Access to the agent's instruction configuration
- **Potential Blockers**: Need to identify the exact file(s) containing agent instructions

## Acceptance Criteria
- [ ] Agent instructions mention DOM state files and their locations
- [ ] Instructions explain when to use `Read` vs `Grep` on `dom.html`
- [ ] Instructions explain how refs cross-reference between aria tree and DOM file
- [ ] Instructions explain how to use diff files for change tracking
- [ ] Instructions cover multiplexer per-instance file paths
- [ ] Instructions include at least 3 concrete usage examples:
  - Grep for a ref to see surrounding context
  - Read the diff after an action to verify changes
  - Read the full DOM when the aria tree is insufficient
- [ ] Agent can successfully use DOM files in a test interaction

## Testing Requirements
- **Unit Tests**: N/A (documentation change)
- **Integration Tests**: N/A
- **Manual Testing**: Run the agent through a form-filling task and verify it uses DOM state files when appropriate
- **Coverage Target**: N/A

## Implementation Notes
Example instruction additions:

```
## DOM State Files

After every browser action, the MCP server writes files to `.playwright-mcp/browser-state/`:

- `dom.html` -- Full page DOM, stripped of noise, with `ref="eN"` attributes matching the aria tree
- `accessibility-tree.yaml` -- The aria snapshot (same as in-context)
- `diffs/NNN-action.diff` -- What changed after each action (unified diff format)

### When to use DOM files

Use the aria tree (in-context) as your primary navigation map -- it tells you element roles, names, and refs.
Use DOM files when you need MORE context:

- **Confused about a field?** Grep for its ref in dom.html to see surrounding labels, help text, error messages:
  `Grep "ref=\"e18\"" .playwright-mcp/browser-state/dom.html -C 5`

- **Debugging a validation error?** Read the diff to see what changed:
  `Read .playwright-mcp/browser-state/diffs/003-fill-form.diff`

- **Need to understand page structure?** Read a section of the DOM:
  `Read .playwright-mcp/browser-state/dom.html` with offset/limit

### For multiplexer instances
Files are per-instance: `.playwright-mcp/browser-state/inst-1/dom.html`, etc.
```

## References
- Spec Section: 14 (Agent Instructions Update)
- Related Tickets: All implementation tickets (this depends on the feature being complete)
