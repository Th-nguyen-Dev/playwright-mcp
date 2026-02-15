# DOM State Efficiency Benchmark

## Testing Plan

---

## 1. What We're Measuring

Does file-based DOM state make AI agents **faster, cheaper, and more accurate** at filling job application forms?

We compare two configurations:
- **Baseline (no DOM state):** Agent has only the aria tree in-context. Must call `browser_snapshot` repeatedly to understand page structure.
- **With DOM state:** Agent has the aria tree in-context + `dom.html`, `accessibility-tree.yaml`, and diffs on disk. Can `Read` and `Grep` files for additional context.

**Key metrics:**

| Metric | What it tells us |
|---|---|
| Total tokens (input + output) | Cost per application |
| Wall clock time | Speed per application |
| Tool call count | How many MCP round trips |
| `browser_snapshot` calls | Redundant snapshotting (should decrease with DOM state) |
| DOM file reads (Read/Grep) | How often the agent uses the DOM file |
| Fields filled correctly | Accuracy — % of fields matching expected values |
| Fields filled incorrectly | Errors — wrong values, wrong format, skipped fields |
| Validation error recovery | Did the agent fix errors? How many retries? |
| Task completion | Binary — did the agent finish the form end-to-end? |

---

## 2. Test Pages

We build local HTML pages that replicate real ATS (Applicant Tracking System) form patterns. No backend needed — forms validate client-side and store values in DOM attributes.

### 2.1 Page Templates

#### `simple-form.html` — Baseline (Low Complexity)

Single-page form with basic fields. This is the control — if DOM state doesn't help here, that's fine. The aria tree is sufficient for simple forms.

- First name, last name, email, phone
- Single dropdown (country)
- One textarea (cover letter)
- Submit button
- No conditional fields, no iframes, no multi-step

Expected: ~10 form fields. Both configurations should succeed. Token difference should be minimal.

#### `greenhouse-style.html` — Standard ATS (Medium Complexity)

Single long-scrolling form with conditional sections and custom screening questions. Modeled after Greenhouse / Lever.

- **Personal info:** name, email, phone, address (street, city, state, zip)
- **Work authorization:** country dropdown, "Are you authorized to work in [country]?" (yes/no)
  - If "no" → reveals "Will you require sponsorship?" dropdown
- **Resume upload:** file input (skip in benchmark, just verify field exists)
- **Work history:** repeatable section — company, title, start date, end date, description
  - Date fields with help text: `<span class="help-text">Format: MM/YYYY</span>`
  - "Add another position" button
- **Education:** school, degree dropdown, field of study, graduation year
- **Custom screening questions:**
  - "Do you have 3+ years of experience with TypeScript?" (yes/no)
  - "What is your expected salary range?" (free text)
  - "How did you hear about this position?" (dropdown)
- **EEO section:** gender, race/ethnicity, veteran status, disability (all optional)
  - Help text explaining these are voluntary and don't affect candidacy

Expected: ~25-30 form fields. Conditional fields and date format help text should demonstrate DOM state value.

#### `workday-style.html` — Enterprise ATS (High Complexity)

Multi-step wizard with iframes, custom components, and complex validation. Modeled after Workday / iCIMS.

- **Step 1: Personal Information**
  - Name, email, phone
  - Address with autocomplete dropdown (rendered in iframe)
  - Date of birth with custom date picker widget
- **Step 2: Experience**
  - Work history (repeatable, with rich text description field)
  - Skills tags — autocomplete search in iframe
  - "Years of experience" dropdown
- **Step 3: Education**
  - School name with autocomplete (iframe)
  - Degree, major, GPA (optional), graduation date
- **Step 4: Additional Information**
  - Cover letter textarea
  - "Why do you want to work here?" textarea
  - Referral source dropdown
  - Checkbox: "I certify this information is accurate"
- **Step navigation:** Next / Previous buttons, step indicator showing progress
- **Validation:** Required field indicators, inline error messages on blur

Expected: ~35-40 form fields across 4 steps. Iframes, multi-step navigation, and complex widgets should strongly demonstrate DOM state value.

### 2.2 What the Test Pages Include

Each page is self-contained HTML with inline CSS/JS:

- **Client-side validation** — required fields, email format, date format
- **Conditional field logic** — show/hide sections based on selections
- **Error messages** — hidden `<span class="error-message">` that appear on validation failure
- **Help text** — `<span class="help-text">` next to complex fields (date format, salary format, etc.)
- **Semantic classes** — `help-text`, `error-message`, `form-group`, `required`, `form-section`
- **Generated classes** — `css-abc123`, `sc-dkPtRN` mixed in for class filtering testing
- **ARIA attributes** — proper `role`, `aria-required`, `aria-describedby`, `aria-invalid`
- **Labels** — proper `<label for="...">` associations
- **Iframe widgets** (workday-style only) — autocomplete dropdowns, date pickers

### 2.3 What the Test Pages Do NOT Need

- Backend / server logic — forms don't submit anywhere
- Authentication — pages are served locally
- Real company branding — just structural replication
- Dynamic data loading — all content is static HTML

---

## 3. Test Data

A fixture file with candidate details the agent should fill in:

```json
// fixtures/candidate-john-doe.json
{
  "personal": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@example.com",
    "phone": "+1 (555) 123-4567",
    "address": {
      "street": "123 Main Street",
      "city": "San Francisco",
      "state": "California",
      "zip": "94105",
      "country": "United States"
    },
    "dateOfBirth": "03/15/1990"
  },
  "workAuthorization": {
    "authorizedToWork": true,
    "requiresSponsorship": false
  },
  "experience": [
    {
      "company": "Acme Corp",
      "title": "Senior Software Engineer",
      "startDate": "06/2020",
      "endDate": "present",
      "description": "Led development of microservices platform serving 10M users."
    },
    {
      "company": "StartupXYZ",
      "title": "Software Engineer",
      "startDate": "01/2018",
      "endDate": "05/2020",
      "description": "Built React frontend and Node.js API for SaaS product."
    }
  ],
  "education": [
    {
      "school": "University of California, Berkeley",
      "degree": "Bachelor of Science",
      "field": "Computer Science",
      "graduationYear": "2017"
    }
  ],
  "screening": {
    "typescriptExperience": true,
    "salaryRange": "$150,000 - $180,000",
    "referralSource": "LinkedIn"
  },
  "eeo": {
    "gender": "Male",
    "race": "Prefer not to say",
    "veteran": "No",
    "disability": "Prefer not to say"
  },
  "additional": {
    "coverLetter": "I am excited to apply for this position...",
    "whyThisCompany": "I admire your team's work on open-source tools...",
    "certifyAccurate": true
  }
}
```

---

## 4. Benchmark Harness

### 4.1 Architecture

```
benchmark/
  pages/
    simple-form.html
    greenhouse-style.html
    workday-style.html
  fixtures/
    candidate-john-doe.json
  src/
    harness.ts              ← orchestrator: runs benchmarks, collects metrics
    server.ts               ← local HTTP server for test pages
    metrics.ts              ← token counting, timing, field validation
    reporter.ts             ← outputs results as markdown table
  results/
    YYYY-MM-DD-HH-MM/
      simple-form-baseline.json
      simple-form-dom-state.json
      greenhouse-baseline.json
      greenhouse-dom-state.json
      workday-baseline.json
      workday-dom-state.json
      summary.md             ← comparison table
```

### 4.2 Harness Flow

```
For each test page (simple, greenhouse, workday):
  For each configuration (baseline, dom-state):
    For each run (1..N, default N=3):

      1. Start local HTTP server serving the test page
      2. Start Playwright MCP instance
         - Baseline: standard config
         - DOM state: config with DOM state enabled
      3. Send prompt to LLM:
         "Navigate to http://localhost:PORT/PAGE.html and fill out the
          job application form with the following candidate information:
          [contents of candidate-john-doe.json]
          Fill every field. Handle any validation errors."
      4. Intercept and log every MCP tool call:
         - Tool name, arguments
         - Response size (bytes)
         - Response time (ms)
         - Token count (input + output for LLM call)
      5. After agent signals completion (or timeout):
         - Extract all form field values from the page
         - Compare against expected values in fixture
         - Record success/failure per field
      6. Collect metrics:
         - Total tokens, wall time, tool calls, snapshot calls
         - DOM file reads (Read/Grep to .playwright-mcp/browser-state/)
         - Field accuracy, error recovery attempts
      7. Save run result to JSON

  Aggregate runs, compute averages, generate summary report
```

### 4.3 LLM Configuration

- Use the same model for all runs (e.g., Claude Sonnet for cost efficiency, or Opus for best performance)
- Same system prompt for both configurations — the only variable is whether DOM state is enabled
- Temperature 0 for reproducibility (though LLMs are still non-deterministic)
- Timeout: 5 minutes per form (generous — a good agent should finish in 1-2 minutes)

### 4.4 How Token Counting Works

The harness sits between the LLM and the MCP server. It sees every tool call and response:

```
LLM  ←→  Harness  ←→  Playwright MCP
          │
          ├─ logs tool name, args, response
          ├─ counts tokens via tiktoken or API usage headers
          └─ timestamps each call
```

For file reads (Read/Grep tool calls), the harness detects calls targeting `.playwright-mcp/browser-state/` paths and counts them separately.

---

## 5. Metrics & Reporting

### 5.1 Per-Run Metrics

```json
{
  "page": "greenhouse-style",
  "config": "dom-state",
  "run": 2,
  "metrics": {
    "totalTokens": 12450,
    "inputTokens": 9200,
    "outputTokens": 3250,
    "wallTimeMs": 45000,
    "toolCalls": 18,
    "snapshotCalls": 3,
    "domFileReads": 4,
    "domFileGreps": 2,
    "fieldsTotal": 28,
    "fieldsCorrect": 26,
    "fieldsIncorrect": 1,
    "fieldsSkipped": 1,
    "validationErrors": 2,
    "validationRecoveries": 2,
    "taskCompleted": true
  }
}
```

### 5.2 Summary Report Format

```markdown
# DOM State Benchmark Results — 2026-02-13

## Simple Form (10 fields)

| Metric | Baseline | DOM State | Delta |
|---|---|---|---|
| Tokens (avg) | 5,200 | 5,400 | +3.8% |
| Time (avg) | 22s | 23s | +4.5% |
| Tool calls | 12 | 11 | -8.3% |
| Snapshot calls | 4 | 2 | -50% |
| DOM reads | 0 | 1 | — |
| Accuracy | 100% | 100% | — |
| Completion | 3/3 | 3/3 | — |

**Verdict:** No significant difference. Simple forms don't benefit from DOM state.

## Greenhouse-Style (28 fields)

| Metric | Baseline | DOM State | Delta |
|---|---|---|---|
| Tokens (avg) | 18,500 | 14,200 | **-23.2%** |
| Time (avg) | 68s | 52s | **-23.5%** |
| Tool calls | 28 | 20 | **-28.6%** |
| Snapshot calls | 8 | 3 | **-62.5%** |
| DOM reads | 0 | 5 | — |
| Accuracy | 85% | 96% | **+11pp** |
| Completion | 2/3 | 3/3 | — |

**Verdict:** Significant improvement. Agent uses DOM to read date format help text,
conditional field structure, and validation errors.

## Workday-Style (38 fields, 4 steps, iframes)

| Metric | Baseline | DOM State | Delta |
|---|---|---|---|
| Tokens (avg) | 32,000 | 22,500 | **-29.7%** |
| Time (avg) | 145s | 95s | **-34.5%** |
| Tool calls | 45 | 30 | **-33.3%** |
| Snapshot calls | 15 | 5 | **-66.7%** |
| DOM reads | 0 | 8 | — |
| Accuracy | 72% | 91% | **+19pp** |
| Completion | 1/3 | 3/3 | — |

**Verdict:** Major improvement. Iframe content, multi-step navigation, and complex
widgets strongly benefit from DOM context.
```

(Numbers above are hypothetical — actual results will vary.)

---

## 6. What We Expect to Find

### 6.1 Hypotheses

1. **Simple forms:** Minimal difference. The aria tree is sufficient. DOM state adds slight overhead (extra file writes) but doesn't help much.

2. **Medium forms (Greenhouse-style):** Moderate improvement. DOM state helps with:
   - Date format help text (the agent reads `dom.html` to find format hints)
   - Conditional fields (the agent sees hidden fields in `dom.html` before they appear)
   - Fewer `browser_snapshot` calls (reads the file instead)

3. **Complex forms (Workday-style):** Significant improvement. DOM state helps with:
   - Iframe widget structure (visible in stitched `dom.html`)
   - Multi-step navigation (diffs show what changed between steps)
   - Complex validation (diffs show `aria-invalid` and error messages)
   - Overall page understanding (fewer snapshot calls, more targeted reads)

### 6.2 What Would Invalidate the Feature

If DOM state shows **no improvement** on complex forms:
- The AI doesn't actually read the DOM files → agent instructions are insufficient
- The DOM file is too noisy → stripping/filtering needs improvement
- The AI can already get enough from the aria tree → the feature is unnecessary
- The overhead outweighs the benefit → tokens spent reading files > tokens saved on snapshots

### 6.3 What Would Validate the Feature

- **Token reduction** of 20%+ on medium/complex forms
- **Accuracy improvement** of 10%+ on complex forms
- **Completion rate improvement** — agent finishes forms it previously abandoned
- **DOM file usage** — agent actually reads the files (if it doesn't, the feature is useless)

---

## 7. Test Page Implementation Notes

### 7.1 Form Validation Script

Each test page includes a validation script that checks fields on blur and on submit:

```javascript
// Inline in each test page
function validateField(input) {
  const value = input.value.trim();
  const errorSpan = input.parentElement.querySelector('.error-message');

  if (input.required && !value) {
    input.setAttribute('aria-invalid', 'true');
    errorSpan.textContent = 'This field is required';
    errorSpan.hidden = false;
    return false;
  }

  if (input.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    input.setAttribute('aria-invalid', 'true');
    errorSpan.textContent = 'Please enter a valid email address';
    errorSpan.hidden = false;
    return false;
  }

  // Date format validation (MM/YYYY or MM/DD/YYYY)
  if (input.dataset.format === 'MM/YYYY' && !/^\d{2}\/\d{4}$/.test(value)) {
    input.setAttribute('aria-invalid', 'true');
    errorSpan.textContent = 'Please use format MM/YYYY';
    errorSpan.hidden = false;
    return false;
  }

  input.removeAttribute('aria-invalid');
  errorSpan.hidden = true;
  return true;
}
```

### 7.2 Field Value Extraction

After the agent finishes, the harness extracts all form values:

```javascript
// Run via page.evaluate() after agent completes
function extractFormValues() {
  const values = {};
  document.querySelectorAll('input, select, textarea').forEach(el => {
    const name = el.name || el.id;
    if (!name) return;
    if (el.type === 'checkbox') values[name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) values[name] = el.value; }
    else values[name] = el.value;
  });
  return values;
}
```

Compare against expected values from the fixture to compute accuracy.

### 7.3 Conditional Field Behavior

Conditional fields use simple show/hide:

```html
<div class="form-group">
  <label for="authorized">Are you authorized to work in the US?</label>
  <select id="authorized" name="authorized" required>
    <option value="">Select...</option>
    <option value="yes">Yes</option>
    <option value="no">No</option>
  </select>
</div>

<div id="sponsorship-section" class="form-group" hidden>
  <label for="sponsorship">Will you require visa sponsorship?</label>
  <select id="sponsorship" name="sponsorship">
    <option value="">Select...</option>
    <option value="yes">Yes</option>
    <option value="no">No</option>
  </select>
  <span class="help-text">This will not affect your candidacy</span>
</div>

<script>
  document.getElementById('authorized').addEventListener('change', function() {
    document.getElementById('sponsorship-section').hidden = this.value !== 'no';
  });
</script>
```

The hidden section is in the DOM (we keep hidden elements). With DOM state, the AI can see it exists before it becomes visible. Without DOM state, the AI only discovers it after selecting "No."

---

## 8. Running the Benchmark

```bash
# Build the harness
cd playwright-mcp/benchmark
npm install

# Run all benchmarks (3 runs each, both configurations)
npx tsx src/harness.ts --runs 3

# Run a specific page only
npx tsx src/harness.ts --page greenhouse-style --runs 5

# Run baseline only (no DOM state)
npx tsx src/harness.ts --config baseline

# Run with a specific model
npx tsx src/harness.ts --model claude-sonnet-4-5-20250929

# View results
cat results/latest/summary.md
```

---

## 9. File Summary

| File | What |
|---|---|
| `benchmark/pages/simple-form.html` | Low complexity test page (~10 fields) |
| `benchmark/pages/greenhouse-style.html` | Medium complexity test page (~28 fields, conditional) |
| `benchmark/pages/workday-style.html` | High complexity test page (~38 fields, multi-step, iframes) |
| `benchmark/fixtures/candidate-john-doe.json` | Test data for form filling |
| `benchmark/src/harness.ts` | Benchmark orchestrator |
| `benchmark/src/server.ts` | Local HTTP server for test pages |
| `benchmark/src/metrics.ts` | Token counting, timing, field validation |
| `benchmark/src/reporter.ts` | Results → markdown summary |
