# TICKET-018: AI agent efficiency evaluation -- does DOM state improve task completion?

## Metadata
| Field | Value |
|-------|-------|
| Status | COMPLETED |
| Priority | P2-Medium |
| Effort | XL (> 8hr) |
| Assignee | Unassigned |

## Description
Design and execute an evaluation to measure whether the DOM state files actually help AI agents complete browser automation tasks more effectively. This is the ultimate measure of the feature's value -- not just "does it work?" but "does it help?"

Compare task completion rates, token usage, error recovery, and step counts with and without DOM state enabled for a set of representative browser automation tasks.

## Technical Approach
- **Architecture Layer**: Evaluation / Research
- **Design Patterns**: A/B comparison, controlled experiment
- **Implementation Strategy**:
  1. Define a set of 5-10 representative tasks (form filling, multi-step workflows, error recovery scenarios)
  2. Create reproducible test environments for each task (local test pages or controlled web apps)
  3. Run each task twice: once with DOM state enabled, once without
  4. Measure: task completion (pass/fail), number of tool calls, number of errors/retries, total tokens used, time to completion
  5. Document findings with specific examples of where DOM state helped or did not help

## Files Affected
- `playwright-mcp/docs/evaluations/dom-state-efficiency.md` - Create - Evaluation design and results
- Test scripts for evaluation scenarios (location TBD)

## Dependencies
- **Prerequisite Tickets**: TICKET-008 (core implementation), TICKET-017 (agent instructions)
- **External Dependencies**: AI agent (Claude, GPT, etc.) for running the evaluation tasks
- **Potential Blockers**: Requires access to an AI agent that can drive the browser; results may vary by model

## Acceptance Criteria
- [ ] At least 5 representative tasks defined with clear success criteria
- [ ] Each task run with DOM state enabled and disabled
- [ ] Metrics collected: completion rate, tool call count, error count, token usage
- [ ] At least one scenario demonstrates clear benefit of DOM state (e.g., error recovery using diff, field identification using grep)
- [ ] Results documented with specific examples
- [ ] Any tasks where DOM state did NOT help are documented with analysis of why

## Testing Requirements
- **Unit Tests**: N/A
- **Integration Tests**: N/A
- **Manual Testing**: Human-supervised AI agent runs
- **Coverage Target**: N/A

## Implementation Notes
Suggested evaluation tasks:

1. **Simple form fill**: 5-field form with clear labels. Baseline: should work without DOM state. Measure: does DOM state reduce errors?

2. **Ambiguous form fields**: Form with unclear labels, help text only visible in DOM. Hypothesis: DOM state helps the agent understand field requirements by reading help text context.

3. **Validation error recovery**: Submit a form with intentional errors, then fix them. Hypothesis: diff shows `aria-invalid` and error messages, helping the agent identify and fix errors faster.

4. **Multi-page workflow**: 3-page wizard form. Hypothesis: diff trail helps the agent track progress across pages.

5. **Complex page with iframes**: Payment form with Stripe-like iframe. Hypothesis: DOM file shows iframe content inline, helping the agent understand the full form structure.

6. **Dropdown with many options**: Country selector with 200 options. Hypothesis: DOM file lets the agent grep for the right option value without scrolling through the aria tree.

7. **Dynamic form**: Form that shows/hides fields based on previous answers. Hypothesis: diff shows newly appeared fields, helping the agent react to dynamic changes.

Measurement template per task:
| Metric | Without DOM State | With DOM State |
|--------|-------------------|----------------|
| Completed | Yes/No | Yes/No |
| Tool calls | N | N |
| Errors/retries | N | N |
| Tokens used | N | N |
| Read/Grep calls | 0 | N |

## References
- Spec Section: 2 (Why Files), 10 (The Agent's Workflow)
- Related Tickets: TICKET-017 (agent instructions -- needed so the agent knows about files)
