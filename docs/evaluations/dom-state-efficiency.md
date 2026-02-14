# DOM State Efficiency Evaluation

## Executive Summary

This evaluation framework measures whether DOM state files (`.playwright-mcp/browser-state/`) improve AI agent performance on browser automation tasks. The hypothesis is that providing agents with on-disk DOM files, accessibility trees, and diffs enables more accurate field identification, better error recovery, and more efficient multi-step workflows compared to relying solely on in-context accessibility tree snapshots.

**What's being tested:**
- Task completion rate (pass/fail)
- Tool call efficiency (number of operations)
- Error recovery capability
- Token usage
- Agent behavior patterns (Read/Grep usage vs repeated navigation)

**Key hypothesis:** DOM state files should help most when:
- Fields are ambiguous or lack clear accessible names
- Validation errors require detailed debugging
- Pages have complex nested structures
- Forms have many options (dropdowns, radio groups)
- Workflows span multiple pages with state transitions

DOM state may provide minimal benefit when:
- Forms are simple with clear labels
- All required context is present in the compact aria tree
- Tasks require only basic navigation and filling

## Methodology

### A/B Comparison Design

Each task is executed twice with the same AI agent and instructions:

**Condition A (Baseline):** DOM state disabled
- Agent receives only in-context accessibility tree snapshots in tool responses
- No `.playwright-mcp/browser-state/` files written
- Agent must rely on aria tree and tool responses alone

**Condition B (Treatment):** DOM state enabled
- All DOM state files written after each action
- Agent instructed to use Read/Grep for additional context
- Agent Guide provided as context

### Controlled Variables

**Keep constant across both conditions:**
- AI model version and temperature
- System prompt and task instructions
- Test page HTML (use local files, served via static HTTP server)
- Browser type and version
- MCP server version
- Time limit per task (10 minutes)

**Measure per condition:**
- Task completion (binary: completed successfully / failed / timed out)
- Total tool calls (all MCP tools)
- Error count (failed tool calls, retries, incorrect actions)
- Token usage (prompt + completion tokens if available)
- Read/Grep calls (should be 0 for Condition A, variable for Condition B)
- Time to completion (seconds)
- Qualitative notes (agent confusion points, recovery strategies)

### Test Environment Setup

1. **Static HTTP server:** Serve test pages from `docs/evaluations/test-pages/` on `http://localhost:8080`
   ```bash
   # Using Python
   python3 -m http.server 8080 -d docs/evaluations/test-pages

   # Or using npx
   npx serve docs/evaluations/test-pages -p 8080
   ```

2. **MCP Server Configuration:**
   - Condition A: Launch with DOM state disabled (default behavior or flag to disable)
   - Condition B: Launch with DOM state enabled (default in current implementation)

3. **Agent Setup:**
   - Provide task instruction clearly
   - For Condition B: Include AI-AGENT-GUIDE.md as context
   - For Condition A: Exclude agent guide, remove any references to DOM files
   - Set consistent system prompt and temperature

4. **Measurement:** Human observer records metrics in real-time using the measurement template below

## Evaluation Tasks

### Task 1: Simple Form Fill (Baseline)

**File:** `01-simple-form.html`

**Scenario:** A straightforward 5-field contact form with clear labels and no validation complexity.

**Task Instruction:**
> Fill out the contact form with the following information:
> - First Name: Alex
> - Last Name: Johnson
> - Email: alex.johnson@example.com
> - Phone: (555) 123-4567
> - Message: I'm interested in learning more about your services.
>
> Submit the form and verify success.

**Success Criteria:**
- All fields filled with correct values
- Form submitted successfully
- Success message displayed

**Expected Behavior:**
- **Baseline hypothesis:** Should complete easily. Aria tree provides sufficient context (clear labels, roles).
- **DOM state hypothesis:** May provide no additional benefit. Fields are unambiguous.
- **Measurement focus:** Does DOM state add overhead without benefit? Check tool call count.

---

### Task 2: Ambiguous Form Fields

**File:** `02-ambiguous-form.html`

**Scenario:** A registration form where field labels are minimal or unclear, but help text and aria-describedby provide necessary context.

**Task Instruction:**
> Complete the user registration form:
> - Account ID: alpha2026
> - Access Code: The format requires 3 letters, 4 numbers (e.g., XYZ1234). Use: QRS5678
> - Recovery method: Choose "Email" and enter: recovery@example.com
> - Confirmation code from the field instruction: Enter the code displayed in the help text below the confirmation field
>
> Submit the form.

**Success Criteria:**
- Account ID entered correctly
- Access code follows format (visible only in help text)
- Recovery method selected and email entered
- Confirmation code read from help text and entered
- Form submitted successfully

**Expected Behavior:**
- **Baseline hypothesis:** May struggle. Help text may not be fully captured in compact aria tree.
- **DOM state hypothesis:** Agent can grep for ref to see full `aria-describedby` relationships and help text content.
- **Measurement focus:** Does agent discover help text faster with DOM? Count retries.

---

### Task 3: Validation Error Recovery

**File:** `03-validation-errors.html`

**Scenario:** A form that validates on submit and displays inline error messages. Agent must submit with intentionally invalid data, then recover by reading errors and fixing them.

**Task Instruction:**
> Fill out the application form:
> - Name: Test User
> - Email: invalid-email (intentionally wrong format)
> - Age: 15 (intentionally below minimum)
> - Website: example.com (intentionally missing https://)
>
> Submit the form. When validation errors appear, fix them based on the error messages:
> - Email should be valid
> - Age should be 25
> - Website should be https://example.com
>
> Resubmit and verify success.

**Success Criteria:**
- Initial submission attempted with invalid data
- Validation errors identified
- All fields corrected based on error messages
- Form successfully submitted on second attempt
- Success message displayed

**Expected Behavior:**
- **Baseline hypothesis:** May struggle to identify exact error messages and associate them with fields.
- **DOM state hypothesis:** Diff shows `aria-invalid="true"` added and error message spans appeared. Agent can grep for error messages or read diff to see changes.
- **Measurement focus:** Error recovery efficiency. Count actions needed to identify and fix errors.

---

### Task 4: Multi-Page Wizard

**File:** `04-wizard-form.html`

**Scenario:** A 3-page form wizard (Personal Info → Preferences → Review). Progress persists via client-side state. Agent must complete all pages.

**Task Instruction:**
> Complete the registration wizard:
>
> Page 1 (Personal Info):
> - First Name: Jordan
> - Last Name: Smith
> - Date of Birth: 1990-05-15
> - Click "Next"
>
> Page 2 (Preferences):
> - Language: Spanish
> - Newsletter: Yes (check the box)
> - Click "Next"
>
> Page 3 (Review):
> - Review the information displayed
> - Click "Submit"
>
> Verify completion.

**Success Criteria:**
- All three pages completed in sequence
- Data persists across pages
- Final submission successful
- Completion message displayed

**Expected Behavior:**
- **Baseline hypothesis:** May lose context between pages. Aria tree resets on each navigation.
- **DOM state hypothesis:** Diff trail shows page transitions. Agent can review previous diffs to confirm data entry.
- **Measurement focus:** Does agent double-check previous entries? Count Read calls on old diffs.

---

### Task 5: Large Dropdown Selection

**File:** `05-large-dropdown.html`

**Scenario:** A form with a country selector containing 200+ countries. Agent must select a specific country that's not near the top of the list.

**Task Instruction:**
> Fill out the shipping form:
> - Full Name: Casey Taylor
> - Country: Zimbabwe (scroll/search to find it in the dropdown)
> - Address: 123 Main Street
> - Postal Code: 00263
>
> Submit the form.

**Success Criteria:**
- Name entered correctly
- Zimbabwe selected from dropdown (near end of alphabetical list)
- Address and postal code entered
- Form submitted successfully

**Expected Behavior:**
- **Baseline hypothesis:** May struggle. Aria tree compacts long option lists. Agent may not see all 200 countries.
- **DOM state hypothesis:** Agent can grep `dom.html` for "Zimbabwe" to find the exact option value without scrolling.
- **Measurement focus:** How does agent find Zimbabwe? Count tool calls before successful selection.

---

### Task 6: Dynamic Form Fields

**File:** `06-dynamic-form.html`

**Scenario:** A form where fields appear/disappear based on previous selections (e.g., "Do you have a car?" → Yes reveals "Car model" field).

**Task Instruction:**
> Complete the survey form:
> - Do you own a car? Select "Yes"
> - (New fields should appear)
> - Car make: Toyota
> - Car year: 2020
> - Do you have insurance? Select "Yes"
> - (New field appears)
> - Insurance provider: State Farm
>
> Submit the form.

**Success Criteria:**
- Initial question answered correctly
- Conditional fields identified and filled
- Nested conditional fields identified and filled
- Form submitted successfully

**Expected Behavior:**
- **Baseline hypothesis:** May struggle to notice new fields appearing. Aria tree updates but agent may not detect changes.
- **DOM state hypothesis:** Diff clearly shows new fields added after each selection. Agent can read diff to see what appeared.
- **Measurement focus:** Does agent proactively check diffs after selections? Count diff reads.

---

### Task 7: Complex Nested Layout

**File:** `07-nested-fieldsets.html`

**Scenario:** A form with multiple fieldsets, legends, nested groups, and fields with similar names in different contexts (e.g., "Phone" in both "Personal Contact" and "Emergency Contact" sections).

**Task Instruction:**
> Fill out the detailed contact form:
>
> Personal Information section:
> - First Name: Morgan
> - Last Name: Lee
> - Phone: (555) 111-2222
> - Email: morgan.lee@example.com
>
> Emergency Contact section:
> - Contact Name: Sam Lee
> - Relationship: Sibling
> - Phone: (555) 333-4444
> - Email: sam.lee@example.com
>
> Medical Information section:
> - Blood Type: O+
> - Allergies: None
>
> Submit the form.

**Success Criteria:**
- All sections identified correctly
- Fields in each section filled with correct values (no mixing up "Phone" fields)
- Form submitted successfully

**Expected Behavior:**
- **Baseline hypothesis:** May confuse fields with similar names. Aria tree may not clearly show fieldset boundaries.
- **DOM state hypothesis:** Grep for ref shows full fieldset/legend context. Agent can disambiguate "Phone" fields by reading surrounding structure.
- **Measurement focus:** Does agent fill correct fields in correct sections? Count errors.

---

## Measurement Template

For each task, record metrics in the following table:

| Metric | Without DOM State | With DOM State |
|--------|-------------------|----------------|
| **Outcome** | Success / Failure / Timeout | Success / Failure / Timeout |
| **Tool calls** | N | N |
| **Errors/Retries** | N | N |
| **Tokens used** | N (if available) | N (if available) |
| **Read/Grep calls** | 0 | N |
| **Time (seconds)** | N | N |
| **Notes** | Observed behavior, blockers | Observed behavior, DOM usage patterns |

### Example Measurement

**Task 3: Validation Error Recovery**

| Metric | Without DOM State | With DOM State |
|--------|-------------------|----------------|
| **Outcome** | Success | Success |
| **Tool calls** | 18 | 12 |
| **Errors/Retries** | 3 (struggled to find error messages) | 0 |
| **Tokens used** | ~8,500 | ~6,200 |
| **Read/Grep calls** | 0 | 3 (read diff, grep for error-message class) |
| **Time (seconds)** | 245 | 156 |
| **Notes** | Re-navigated aria tree multiple times trying to locate error messages. Eventually found them by clicking around. | Read diff immediately after failed submit, saw aria-invalid and error spans. Grepped for error-message class to confirm all errors. Fixed efficiently. |

## Running the Evaluation

### Step-by-Step Process

1. **Prepare test pages:**
   ```bash
   cd docs/evaluations/test-pages
   python3 -m http.server 8080
   ```
   Verify all 7 pages load correctly at `http://localhost:8080/0N-*.html`

2. **Configure MCP server:**
   - Condition A: Disable DOM state file writing (modify server config or use flag)
   - Condition B: Enable DOM state file writing (default)

3. **For each task (1-7):**

   a. **Run Condition A (baseline):**
      - Clear any previous browser state
      - Launch MCP server with DOM state disabled
      - Connect AI agent to MCP server
      - Provide task instruction to agent
      - Do NOT provide AI-AGENT-GUIDE.md
      - Start timer
      - Observe and record metrics in template
      - Stop when task completes, fails, or times out (10 min)

   b. **Run Condition B (treatment):**
      - Clear browser state from previous run
      - Launch MCP server with DOM state enabled
      - Connect AI agent to MCP server
      - Provide SAME task instruction
      - Provide AI-AGENT-GUIDE.md as additional context
      - Start timer
      - Observe and record metrics in template
      - Stop when task completes, fails, or times out (10 min)

   c. **Record qualitative observations:**
      - Where did the agent struggle?
      - What triggered Read/Grep usage?
      - Were there unexpected patterns?

4. **Aggregate results:**
   - Calculate completion rate per condition (N tasks completed / 7 total)
   - Average tool calls per completed task
   - Average errors per task
   - Average tokens (if available)
   - Identify patterns: which tasks benefited most from DOM state?

5. **Document findings:**
   - Add results section below
   - Include specific examples of where DOM state helped or didn't help
   - Analyze which hypothesis were confirmed or refuted

## Results

*To be filled in after running the evaluation*

### Summary Statistics

| Condition | Completion Rate | Avg Tool Calls | Avg Errors | Avg Time (s) |
|-----------|----------------|----------------|------------|--------------|
| Without DOM State | N/7 | N | N | N |
| With DOM State | N/7 | N | N | N |

### Task-by-Task Results

*Include completed measurement tables for all 7 tasks*

### Key Findings

*Document specific examples:*

1. **Where DOM state clearly helped:**
   - Task N: [Specific example of how Read/Grep usage improved outcome]
   - Task N: [Example of diff-based error recovery]

2. **Where DOM state made little difference:**
   - Task N: [Example where aria tree was sufficient]

3. **Unexpected behaviors:**
   - [Any surprising patterns, agent strategies, or edge cases discovered]

4. **Recommendations:**
   - Should DOM state be enabled by default?
   - Which agent instructions are most effective?
   - Are there task types where DOM state should be strongly recommended vs optional?

## Analysis Framework

### Qualitative Coding

When reviewing agent behavior, code observations into these categories:

**DOM State Usage Patterns:**
- Proactive (agent reads DOM/diffs without prompting)
- Reactive (agent uses DOM after encountering difficulty)
- Minimal (agent provided DOM state but rarely uses it)
- None (baseline condition)

**Error Recovery Strategies:**
- Trial-and-error (repeated actions until success)
- Diff-based (reads diff to diagnose issue)
- Grep-based (searches DOM for error messages or help text)
- Aria-only (relies on in-context aria tree updates)

**Field Identification Methods:**
- Label matching (uses accessible name from aria tree)
- Context grep (greps for ref to see surrounding labels/help text)
- DOM scan (reads large sections of DOM to understand structure)
- Progressive refinement (tries action, checks result, adjusts)

### Statistical Considerations

With only 7 tasks, this evaluation is exploratory rather than statistically powered. Focus on:
- **Effect size:** Large, obvious differences matter more than p-values
- **Patterns:** Do multiple tasks show consistent behavior?
- **Qualitative depth:** Specific examples are more valuable than aggregate numbers

If extending the evaluation:
- Add more tasks (target: 20-30 for statistical power)
- Test multiple AI models (GPT-4, Claude, Gemini)
- Test multiple agents/prompting strategies
- Randomize task order to control for learning effects

## Future Enhancements

Potential extensions to this evaluation:

1. **Automated evaluation harness:**
   - Script that runs both conditions automatically
   - Captures tool calls, responses, and timing programmatically
   - Reduces human observation burden

2. **Objective success criteria validation:**
   - Each test page includes a `/verify` endpoint that returns JSON with success state
   - Automated scoring based on form data submission

3. **Token usage tracking:**
   - Instrument MCP server to log exact token counts per task
   - Compare prompt size with vs without DOM files in context

4. **Multiple agent comparison:**
   - Run same tasks with GPT-4, Claude Opus, Gemini
   - Measure variance across models

5. **Real-world task corpus:**
   - Extend beyond synthetic test pages to real websites
   - Job application forms, e-commerce checkouts, SaaS onboarding

6. **Longitudinal evaluation:**
   - Re-run evaluation as models improve
   - Track whether future models benefit more or less from DOM state

## Conclusion

This evaluation framework provides a structured methodology to answer the key question: **Does DOM state improve AI agent efficiency?**

By comparing agent performance with and without DOM state files across diverse, representative tasks, we can:
- Validate the value proposition of the feature
- Identify optimal use cases
- Improve agent instructions and documentation
- Make data-driven decisions about default settings

The focus is on actionable insights: specific examples of where DOM state helps, concrete metrics showing efficiency gains, and clear recommendations for users.
