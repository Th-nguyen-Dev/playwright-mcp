# Playwright MCP Multiplexer -- Bug Fix Backlog

> Generated from audit findings on 2026-03-01. All bugs verified against source code.

## Ticket Index Table

| Ticket | Title | Priority | Effort | Status | Dependencies | Phase |
|--------|-------|----------|--------|--------|--------------|-------|
| [MUX-001](tickets/MUX-001.md) | Remove `--headless` CLI flag that defeats Xvfb anti-detection | P0-Critical | S | TODO | None | 0: Critical Fixes |
| [MUX-002](tickets/MUX-002.md) | Wait for MCP handshake before calling `listRoots()` | P0-Critical | S | COMPLETED | None | 0: Critical Fixes |
| [MUX-003](tickets/MUX-003.md) | Normalize error handling in `handleProxyTool` | P1-High | S | TODO | None | 0: Critical Fixes |
| [MUX-004](tickets/MUX-004.md) | Add discovery mutex to prevent concurrent `discoverTools()` races | P2-Medium | S | TODO | None | 1: Stability |
| [MUX-005](tickets/MUX-005.md) | Check system-wide display numbers before Xvfb allocation | P2-Medium | M | TODO | None | 1: Stability |
| [MUX-006](tickets/MUX-006.md) | Fix Xvfb exit/resolve race in `spawnXvfb()` | P2-Medium | M | TODO | None | 1: Stability |
| [MUX-007](tickets/MUX-007.md) | Use `Promise.allSettled()` in `closeAll()` | P2-Medium | S | TODO | None | 1: Stability |
| [MUX-008](tickets/MUX-008.md) | Remove unused `InitializedNotificationSchema` import | P3-Low | S | COMPLETED | MUX-002 | 2: Cleanup |
| [MUX-009](tickets/MUX-009.md) | Remove dead `headless` parameter from `createLaunchConfig()` | P3-Low | S | TODO | MUX-001 | 2: Cleanup |
| [MUX-010](tickets/MUX-010.md) | Prevent double Ctrl+C from interrupting graceful shutdown | P3-Low | S | TODO | None | 2: Cleanup |
| [MUX-011](tickets/MUX-011.md) | Validate `savePath` in auth export for path traversal | P3-Low | S | TODO | None | 2: Cleanup |
| [MUX-012](tickets/MUX-012.md) | Replace linear `isProxyTool()` scan with `Set` lookup | P3-Low | S | TODO | None | 2: Cleanup |

## Dependency Graph

```
MUX-001 (--headless flag defeats Xvfb)         MUX-002 (listRoots before handshake)         MUX-003 (error contract)
    |                                               |
    +---> MUX-009 (dead headless param)             +---> MUX-008 (unused import)

MUX-004 (discovery race)       [independent]
MUX-005 (display collisions)   [independent]
MUX-006 (Xvfb exit race)      [independent]
MUX-007 (closeAll abandons)    [independent]
MUX-010 (double Ctrl+C)       [independent]
MUX-011 (savePath traversal)   [independent]
MUX-012 (linear scan)         [independent]
```

## Execution Order

| Tier | Tickets (parallelizable) | Blocked By |
|------|--------------------------|------------|
| 0 | MUX-001, MUX-002, MUX-003 | -- |
| 1 | MUX-004, MUX-005, MUX-006, MUX-007 | -- |
| 2 | MUX-008, MUX-009, MUX-010, MUX-011, MUX-012 | MUX-008 blocked by MUX-002; MUX-009 blocked by MUX-001 |

**Notes on tier ordering:**
- Tier 0 contains the critical and high-severity bugs. These should be fixed first.
- Tier 1 contains medium-severity stability bugs. All are independent of each other and of Tier 0, so they CAN run in parallel with Tier 0. However, prioritizing Tier 0 first is recommended.
- Tier 2 contains low-severity cleanup tickets. MUX-008 and MUX-009 are blocked by Tier 0 tickets (they are resolved as side effects of MUX-002 and MUX-001 respectively). MUX-010, MUX-011, MUX-012 are independent and can run any time.

## Critical Path

The longest dependency chain is trivially short:

```
MUX-002 (S, <1hr) ---> MUX-008 (S, <1hr)
MUX-001 (S, <1hr) ---> MUX-009 (S, <1hr)
```

**Total critical path estimate: ~2 hours** (both chains can run in parallel).

**Total backlog estimate:**
- 10 tickets at S effort (~1hr each) = ~10 hours
- 2 tickets at M effort (~2hr each) = ~4 hours
- **Grand total: ~14 hours of work**
- With 3 parallel workers on Tier 0 + 4 on Tier 1: **~5 hours wall-clock time**

## Files Affected Summary

| File | Tickets |
|------|---------|
| `src/instance-manager.ts` | MUX-001, MUX-007, MUX-009 |
| `src/multiplexer-server.ts` | MUX-002, MUX-004, MUX-008 |
| `src/tool-router.ts` | MUX-003 |
| `src/tool-registry.ts` | MUX-012 |
| `src/virtual-display.ts` | MUX-005, MUX-006 |
| `src/auth-manager.ts` | MUX-011 |
| `cli.ts` | MUX-010 |

**Merge conflict risk**: MUX-001 and MUX-007 both modify `instance-manager.ts` but touch different methods (no overlap). MUX-005 and MUX-006 both modify `virtual-display.ts` but touch different methods. MUX-002 and MUX-004 both modify `multiplexer-server.ts` -- MUX-002 changes `connect()` while MUX-004 changes `registerHandlers()` and adds a new method, so conflict risk is minimal.
