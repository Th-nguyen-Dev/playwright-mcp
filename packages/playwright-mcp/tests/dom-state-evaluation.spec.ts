/**
 * DOM State A/B Evaluation
 *
 * Drives 7 evaluation tasks through the MCP server in two conditions:
 *   A (Baseline): No workspace roots → DOM state disabled
 *   B (Treatment): With workspace roots → DOM state enabled
 *
 * For each task, records:
 *   - Tool call count
 *   - Whether DOM state files were generated
 *   - DOM file sizes and diff trail
 *   - Response content sizes (what the agent sees)
 *   - Task completion (success message in final snapshot)
 */

import { test, expect } from './fixtures';
import fs from 'fs';
import path from 'path';

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract a ref from an aria snapshot line matching a pattern.
 *  Handles alternation patterns with multiple capture groups. */
function extractRef(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  if (!match)
    throw new Error(`Could not find ref for pattern: ${pattern}\n\nSnapshot excerpt:\n${text.slice(0, 3000)}`);
  // Return first non-undefined capture group (handles alternation patterns)
  for (let i = 1; i < match.length; i++) {
    if (match[i] !== undefined)
      return match[i];
  }
  throw new Error(`No capture group matched for pattern: ${pattern}`);
}

type Metrics = {
  toolCalls: number;
  errors: number;
  completed: boolean;
  totalResponseSize: number;
  domState: {
    domExists: boolean;
    ariaExists: boolean;
    domSize: number;
    ariaSize: number;
    diffCount: number;
    diffFiles: string[];
    totalDiffSize: number;
  } | null;
};

async function checkDomState(workspaceDir: string | null): Promise<Metrics['domState']> {
  if (!workspaceDir)
    return null;

  const stateDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state');
  const domPath = path.join(stateDir, 'dom.html');
  const ariaPath = path.join(stateDir, 'accessibility-tree.yaml');
  const diffsDir = path.join(stateDir, 'diffs');

  const domExists = await fs.promises.access(domPath).then(() => true).catch(() => false);
  const ariaExists = await fs.promises.access(ariaPath).then(() => true).catch(() => false);
  const domSize = domExists ? (await fs.promises.stat(domPath)).size : 0;
  const ariaSize = ariaExists ? (await fs.promises.stat(ariaPath)).size : 0;

  let diffCount = 0;
  let diffFiles: string[] = [];
  let totalDiffSize = 0;
  const diffsExist = await fs.promises.access(diffsDir).then(() => true).catch(() => false);
  if (diffsExist) {
    diffFiles = (await fs.promises.readdir(diffsDir)).sort();
    diffCount = diffFiles.length;
    for (const f of diffFiles) {
      const stat = await fs.promises.stat(path.join(diffsDir, f));
      totalDiffSize += stat.size;
    }
  }

  return { domExists, ariaExists, domSize, ariaSize, diffCount, diffFiles, totalDiffSize };
}

function txt(response: any): string {
  return (response.content as any)[0]?.text ?? '';
}

/** Load an evaluation test page HTML from disk */
function loadTestPage(filename: string): string {
  const pagePath = path.resolve(__dirname, '../../../docs/evaluations/test-pages', filename);
  return fs.readFileSync(pagePath, 'utf-8');
}

function logMetrics(taskName: string, condition: string, metrics: Metrics, extra?: Record<string, any>) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${taskName} — Condition ${condition}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Completed:        ${metrics.completed}`);
  console.log(`  Tool calls:       ${metrics.toolCalls}`);
  console.log(`  Errors:           ${metrics.errors}`);
  console.log(`  Response size:    ${metrics.totalResponseSize} chars`);
  if (metrics.domState) {
    console.log(`  DOM file:         ${metrics.domState.domExists} (${metrics.domState.domSize} bytes)`);
    console.log(`  Aria file:        ${metrics.domState.ariaExists} (${metrics.domState.ariaSize} bytes)`);
    console.log(`  Diff count:       ${metrics.domState.diffCount}`);
    console.log(`  Diff files:       ${metrics.domState.diffFiles.join(', ')}`);
    console.log(`  Total diff size:  ${metrics.domState.totalDiffSize} bytes`);
  } else {
    console.log(`  DOM state:        DISABLED`);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra))
      console.log(`  ${k}: ${v}`);
  }
}

type ClientSetup = { client: any; workspaceDir: string | null };

async function setupClient(
  startClient: any,
  condition: 'A' | 'B',
): Promise<ClientSetup> {
  const workspaceDir = condition === 'B' ? test.info().outputPath('workspace') : null;
  if (workspaceDir)
    await fs.promises.mkdir(workspaceDir, { recursive: true });

  const { client } = await startClient({
    ...(workspaceDir ? { roots: [{ name: 'workspace', uri: `file://${workspaceDir}` }] } : {}),
  });

  return { client, workspaceDir };
}

// ─── Tests ──────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

test.describe('DOM State A/B Evaluation', () => {

  // ── Task 1: Simple Form Fill ──────────────────────────────────────

  for (const condition of ['A', 'B'] as const) {
    test(`Task 1: Simple Form — Condition ${condition}`, async ({ startClient, server }) => {
      server.setContent('/eval/01', loadTestPage('01-simple-form.html'), 'text/html');
      const { client, workspaceDir } = await setupClient(startClient, condition);
      const m: Metrics = { toolCalls: 0, errors: 0, completed: false, totalResponseSize: 0, domState: null };

      // Navigate
      const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + 'eval/01' } });
      m.toolCalls++; m.totalResponseSize += txt(nav).length;
      const t = txt(nav);

      // Extract all refs from initial snapshot
      const firstNameRef = extractRef(t, /First Name.*\[ref=(e\d+)\]/);
      const lastNameRef = extractRef(t, /Last Name.*\[ref=(e\d+)\]/);
      const emailRef = extractRef(t, /Email.*\[ref=(e\d+)\]/);
      const phoneRef = extractRef(t, /Phone.*\[ref=(e\d+)\]/);
      const messageRef = extractRef(t, /Message.*\[ref=(e\d+)\]/);
      const submitRef = extractRef(t, /Send Message.*\[ref=(e\d+)\]/);

      // Fill form
      const fill = await client.callTool({
        name: 'browser_fill_form',
        arguments: {
          fields: [
            { name: 'First Name', type: 'textbox', ref: firstNameRef, value: 'Alex' },
            { name: 'Last Name', type: 'textbox', ref: lastNameRef, value: 'Johnson' },
            { name: 'Email', type: 'textbox', ref: emailRef, value: 'alex.johnson@example.com' },
            { name: 'Phone', type: 'textbox', ref: phoneRef, value: '(555) 123-4567' },
            { name: 'Message', type: 'textbox', ref: messageRef, value: "I'm interested in learning more about your services." },
          ],
        },
      });
      m.toolCalls++; m.totalResponseSize += txt(fill).length;
      if (fill.isError) m.errors++;

      // Submit
      const submit = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Send Message button', ref: submitRef },
      });
      m.toolCalls++; m.totalResponseSize += txt(submit).length;

      m.completed = txt(submit).includes('Thank you') || txt(submit).includes('successfully');
      m.domState = await checkDomState(workspaceDir);
      logMetrics('Task 1: Simple Form', condition, m);

      expect(m.completed).toBe(true);
      if (condition === 'B') {
        expect(m.domState?.domExists).toBe(true);
        expect(m.domState?.ariaExists).toBe(true);
      }
    });
  }

  // ── Task 2: Ambiguous Form Fields ─────────────────────────────────

  for (const condition of ['A', 'B'] as const) {
    test(`Task 2: Ambiguous Form — Condition ${condition}`, async ({ startClient, server }) => {
      server.setContent('/eval/02', loadTestPage('02-ambiguous-form.html'), 'text/html');
      const { client, workspaceDir } = await setupClient(startClient, condition);
      const m: Metrics = { toolCalls: 0, errors: 0, completed: false, totalResponseSize: 0, domState: null };

      // Navigate — extract all stable refs from the full initial snapshot
      const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + 'eval/02' } });
      m.toolCalls++; m.totalResponseSize += txt(nav).length;
      const navText = txt(nav);

      // Extract refs from full navigate snapshot (these are stable)
      const accountIdRef = extractRef(navText, /ID.*\[ref=(e\d+)\]/);
      const codeRef = extractRef(navText, /Code.*\[ref=(e\d+)\]/);
      const recoveryRef = extractRef(navText, /Recovery.*combobox.*\[ref=(e\d+)\]|combobox "Recovery".*\[ref=(e\d+)\]/);
      const confirmRef = extractRef(navText, /Verification.*\[ref=(e\d+)\]/);
      const submitRef = extractRef(navText, /Create Account.*\[ref=(e\d+)\]/);

      // Fill account ID and access code using fill_form (batch, one snapshot)
      const fill1 = await client.callTool({
        name: 'browser_fill_form',
        arguments: {
          fields: [
            { name: 'ID', type: 'textbox', ref: accountIdRef, value: 'alpha2026' },
            { name: 'Code', type: 'textbox', ref: codeRef, value: 'QRS5678' },
          ],
        },
      });
      m.toolCalls++; m.totalResponseSize += txt(fill1).length;

      // Select recovery method → Email
      const r3 = await client.callTool({
        name: 'browser_select_option',
        arguments: { element: 'Recovery combobox', ref: recoveryRef, values: ['email'] },
      });
      m.toolCalls++; m.totalResponseSize += txt(r3).length;

      // Fill recovery email (dynamically revealed — extract ref from this snapshot)
      const recoveryEmailRef = extractRef(txt(r3), /Recovery Address.*\[ref=(e\d+)\]/);
      const fill2 = await client.callTool({
        name: 'browser_fill_form',
        arguments: {
          fields: [
            { name: 'Recovery Address', type: 'textbox', ref: recoveryEmailRef, value: 'recovery@example.com' },
            { name: 'Verification', type: 'textbox', ref: confirmRef, value: 'CONF2026' },
          ],
        },
      });
      m.toolCalls++; m.totalResponseSize += txt(fill2).length;

      // Submit explicitly via click
      const submit = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Create Account', ref: submitRef },
      });
      m.toolCalls++; m.totalResponseSize += txt(submit).length;

      m.completed = txt(submit).includes('successfully') || txt(submit).includes('Welcome');
      m.domState = await checkDomState(workspaceDir);

      // Check if agent could have found help text in aria vs DOM
      const ariaHasHelpText = txt(nav).includes('3 uppercase letters');
      const extra: Record<string, any> = {
        'Help text in aria': ariaHasHelpText,
      };
      if (condition === 'B' && workspaceDir) {
        const domPath = path.join(workspaceDir, '.playwright-mcp', 'browser-state', 'dom.html');
        const domExists = await fs.promises.access(domPath).then(() => true).catch(() => false);
        if (domExists) {
          const dom = await fs.promises.readFile(domPath, 'utf-8');
          extra['Help text in DOM'] = dom.includes('3 uppercase letters');
          extra['CONF2026 in DOM'] = dom.includes('CONF2026');
        }
      }
      logMetrics('Task 2: Ambiguous Form', condition, m, extra);

      expect(m.completed).toBe(true);
      if (condition === 'B') {
        expect(m.domState?.domExists).toBe(true);
      }
    });
  }

  // ── Task 3: Validation Error Recovery ─────────────────────────────

  for (const condition of ['A', 'B'] as const) {
    test(`Task 3: Validation Errors — Condition ${condition}`, async ({ startClient, server }) => {
      server.setContent('/eval/03', loadTestPage('03-validation-errors.html'), 'text/html');
      const { client, workspaceDir } = await setupClient(startClient, condition);
      const m: Metrics = { toolCalls: 0, errors: 0, completed: false, totalResponseSize: 0, domState: null };

      // Navigate
      const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + 'eval/03' } });
      m.toolCalls++; m.totalResponseSize += txt(nav).length;
      let t = txt(nav);

      // Fill with invalid data
      const nameRef = extractRef(t, /Full Name.*\[ref=(e\d+)\]/);
      const emailRef = extractRef(t, /Email.*\[ref=(e\d+)\]/);
      const ageRef = extractRef(t, /Age.*\[ref=(e\d+)\]/);
      const websiteRef = extractRef(t, /Website.*\[ref=(e\d+)\]/);
      const submitRef = extractRef(t, /Submit Application.*\[ref=(e\d+)\]/);

      const fill1 = await client.callTool({
        name: 'browser_fill_form',
        arguments: {
          fields: [
            { name: 'Full Name', type: 'textbox', ref: nameRef, value: 'Test User' },
            { name: 'Email Address', type: 'textbox', ref: emailRef, value: 'invalid-email' },
            { name: 'Age', type: 'textbox', ref: ageRef, value: '15' },
            { name: 'Website URL', type: 'textbox', ref: websiteRef, value: 'example.com' },
          ],
        },
      });
      m.toolCalls++; m.totalResponseSize += txt(fill1).length;

      // Submit (triggers validation errors)
      const submit1 = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Submit Application', ref: submitRef },
      });
      m.toolCalls++; m.totalResponseSize += txt(submit1).length;
      t = txt(submit1);

      const ariaShowsErrors = t.includes('invalid') || t.includes('valid email') || t.includes('between 18');

      // Check diff for validation errors (Condition B)
      const extra: Record<string, any> = { 'Errors in aria': ariaShowsErrors };
      if (condition === 'B' && workspaceDir) {
        const diffsDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state', 'diffs');
        const exists = await fs.promises.access(diffsDir).then(() => true).catch(() => false);
        if (exists) {
          const diffs = (await fs.promises.readdir(diffsDir)).sort();
          if (diffs.length > 0) {
            const lastDiff = await fs.promises.readFile(path.join(diffsDir, diffs[diffs.length - 1]), 'utf-8');
            extra['aria-invalid in diff'] = lastDiff.includes('aria-invalid');
            extra['error-message in diff'] = lastDiff.includes('error');
          }
        }
      }

      // Fix errors — reuse refs from navigate (refs are stable within a session)
      const fix = await client.callTool({
        name: 'browser_fill_form',
        arguments: {
          fields: [
            { name: 'Email Address', type: 'textbox', ref: emailRef, value: 'user@example.com' },
            { name: 'Age', type: 'textbox', ref: ageRef, value: '25' },
            { name: 'Website URL', type: 'textbox', ref: websiteRef, value: 'https://example.com' },
          ],
        },
      });
      m.toolCalls++; m.totalResponseSize += txt(fix).length;

      // Resubmit
      const submit2 = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Submit Application', ref: submitRef },
      });
      m.toolCalls++; m.totalResponseSize += txt(submit2).length;

      m.completed = txt(submit2).includes('successfully') || txt(submit2).includes('submitted');
      m.domState = await checkDomState(workspaceDir);
      logMetrics('Task 3: Validation Errors', condition, m, extra);

      expect(m.completed).toBe(true);
      if (condition === 'B') {
        expect(m.domState?.diffCount).toBeGreaterThanOrEqual(2);
      }
    });
  }

  // ── Task 4: Multi-Page Wizard ─────────────────────────────────────

  for (const condition of ['A', 'B'] as const) {
    test(`Task 4: Wizard Form — Condition ${condition}`, async ({ startClient, server }) => {
      server.setContent('/eval/04', loadTestPage('04-wizard-form.html'), 'text/html');
      const { client, workspaceDir } = await setupClient(startClient, condition);
      const m: Metrics = { toolCalls: 0, errors: 0, completed: false, totalResponseSize: 0, domState: null };

      // Navigate
      const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + 'eval/04' } });
      m.toolCalls++; m.totalResponseSize += txt(nav).length;
      let t = txt(nav);

      // Page 1: Personal Info
      const firstNameRef = extractRef(t, /First Name.*\[ref=(e\d+)\]/);
      const lastNameRef = extractRef(t, /Last Name.*\[ref=(e\d+)\]/);
      const dobRef = extractRef(t, /Date of Birth.*\[ref=(e\d+)\]/);
      const nextRef1 = extractRef(t, /Next.*\[ref=(e\d+)\]/);

      const fill1 = await client.callTool({
        name: 'browser_fill_form',
        arguments: {
          fields: [
            { name: 'First Name', type: 'textbox', ref: firstNameRef, value: 'Jordan' },
            { name: 'Last Name', type: 'textbox', ref: lastNameRef, value: 'Smith' },
            { name: 'Date of Birth', type: 'textbox', ref: dobRef, value: '1990-05-15' },
          ],
        },
      });
      m.toolCalls++; m.totalResponseSize += txt(fill1).length;

      // Click Next → Page 2
      const next1 = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Next', ref: nextRef1 },
      });
      m.toolCalls++; m.totalResponseSize += txt(next1).length;
      t = txt(next1);

      // Page 2: Preferences
      const langRef = extractRef(t, /Preferred Language.*\[ref=(e\d+)\]/);
      const selectLang = await client.callTool({
        name: 'browser_select_option',
        arguments: { element: 'Preferred Language', ref: langRef, values: ['Spanish'] },
      });
      m.toolCalls++; m.totalResponseSize += txt(selectLang).length;
      t = txt(selectLang);

      // Check newsletter checkbox
      const newsletterRef = extractRef(t, /newsletter.*\[ref=(e\d+)\]/i);
      const checkNews = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'newsletter checkbox', ref: newsletterRef },
      });
      m.toolCalls++; m.totalResponseSize += txt(checkNews).length;
      t = txt(checkNews);

      // Click Next → Page 3
      const nextRef2 = extractRef(t, /Next.*\[ref=(e\d+)\]/);
      const next2 = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Next', ref: nextRef2 },
      });
      m.toolCalls++; m.totalResponseSize += txt(next2).length;
      t = txt(next2);

      // Page 3: Review → Submit
      const submitRef = extractRef(t, /Submit.*\[ref=(e\d+)\]/);
      const submit = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Submit', ref: submitRef },
      });
      m.toolCalls++; m.totalResponseSize += txt(submit).length;

      m.completed = txt(submit).includes('successfully') || txt(submit).includes('completed');
      m.domState = await checkDomState(workspaceDir);

      const extra: Record<string, any> = {};
      if (condition === 'B' && m.domState) {
        extra['Diff trail length'] = m.domState.diffCount;
        extra['Diff trail'] = m.domState.diffFiles.join(' → ');
      }
      logMetrics('Task 4: Wizard Form', condition, m, extra);

      expect(m.completed).toBe(true);
      if (condition === 'B') {
        expect(m.domState?.diffCount).toBeGreaterThanOrEqual(3);
      }
    });
  }

  // ── Task 5: Large Dropdown Selection ──────────────────────────────

  for (const condition of ['A', 'B'] as const) {
    test(`Task 5: Large Dropdown — Condition ${condition}`, async ({ startClient, server }) => {
      server.setContent('/eval/05', loadTestPage('05-large-dropdown.html'), 'text/html');
      const { client, workspaceDir } = await setupClient(startClient, condition);
      const m: Metrics = { toolCalls: 0, errors: 0, completed: false, totalResponseSize: 0, domState: null };

      // Navigate
      const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + 'eval/05' } });
      m.toolCalls++; m.totalResponseSize += txt(nav).length;
      let t = txt(nav);

      // Check if Zimbabwe is visible in the aria snapshot
      const ariaHasZimbabwe = t.includes('Zimbabwe');

      // Extract all refs from full navigate snapshot
      const nameRef = extractRef(t, /Full Name.*\[ref=(e\d+)\]/);
      const countryRef = extractRef(t, /Country.*\[ref=(e\d+)\]/);
      const addressRef = extractRef(t, /Street Address.*\[ref=(e\d+)\]/);
      const postalRef = extractRef(t, /Postal Code.*\[ref=(e\d+)\]/);
      const shipRef = extractRef(t, /Ship Order.*\[ref=(e\d+)\]/);

      // Fill name
      const r1 = await client.callTool({
        name: 'browser_type',
        arguments: { element: 'Full Name', ref: nameRef, text: 'Casey Taylor', submit: true },
      });
      m.toolCalls++; m.totalResponseSize += txt(r1).length;

      // Select country: Zimbabwe
      const r2 = await client.callTool({
        name: 'browser_select_option',
        arguments: { element: 'Country', ref: countryRef, values: ['Zimbabwe'] },
      });
      m.toolCalls++; m.totalResponseSize += txt(r2).length;

      const fill = await client.callTool({
        name: 'browser_fill_form',
        arguments: {
          fields: [
            { name: 'Street Address', type: 'textbox', ref: addressRef, value: '123 Main Street' },
            { name: 'Postal Code', type: 'textbox', ref: postalRef, value: '00263' },
          ],
        },
      });
      m.toolCalls++; m.totalResponseSize += txt(fill).length;

      // Submit
      const submit = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Ship Order', ref: shipRef },
      });
      m.toolCalls++; m.totalResponseSize += txt(submit).length;

      m.completed = txt(submit).includes('submitted') || txt(submit).includes('Shipping');
      m.domState = await checkDomState(workspaceDir);

      const extra: Record<string, any> = { 'Zimbabwe in aria snapshot': ariaHasZimbabwe };
      if (condition === 'B' && workspaceDir) {
        const domPath = path.join(workspaceDir, '.playwright-mcp', 'browser-state', 'dom.html');
        const domExists = await fs.promises.access(domPath).then(() => true).catch(() => false);
        if (domExists) {
          const dom = await fs.promises.readFile(domPath, 'utf-8');
          extra['Zimbabwe in DOM'] = dom.includes('Zimbabwe');
          extra['Country options in DOM'] = (dom.match(/<option/g) || []).length;
        }
      }
      logMetrics('Task 5: Large Dropdown', condition, m, extra);

      expect(m.completed).toBe(true);
    });
  }

  // ── Task 6: Dynamic Form Fields ───────────────────────────────────

  for (const condition of ['A', 'B'] as const) {
    test(`Task 6: Dynamic Form — Condition ${condition}`, async ({ startClient, server }) => {
      server.setContent('/eval/06', loadTestPage('06-dynamic-form.html'), 'text/html');
      const { client, workspaceDir } = await setupClient(startClient, condition);
      const m: Metrics = { toolCalls: 0, errors: 0, completed: false, totalResponseSize: 0, domState: null };

      // Navigate — extract stable refs
      const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + 'eval/06' } });
      m.toolCalls++; m.totalResponseSize += txt(nav).length;
      const navText = txt(nav);

      const carFieldsInitially = navText.includes('Car Make');
      const carYesRef = extractRef(navText, /Yes.*\[ref=(e\d+)\]/);
      const submitRef = extractRef(navText, /Submit Survey.*\[ref=(e\d+)\]/);

      // Click "Yes" for car ownership → reveals car fields
      const r1 = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Yes radio', ref: carYesRef },
      });
      m.toolCalls++; m.totalResponseSize += txt(r1).length;
      const afterCarYes = txt(r1);
      const carFieldsAfterYes = afterCarYes.includes('Car Make');

      // Extract dynamic refs from the click response (new elements appeared)
      const carMakeRef = extractRef(afterCarYes, /Car Make.*\[ref=(e\d+)\]/);
      const carYearRef = extractRef(afterCarYes, /Car Year.*\[ref=(e\d+)\]/);
      // Also extract the insurance "Yes" radio that appeared with car details
      const insuranceYesMatches = [...afterCarYes.matchAll(/Yes.*\[ref=(e\d+)\]/g)];
      // The insurance Yes is a DIFFERENT ref than carYesRef
      const insuranceYesRef = insuranceYesMatches.find(m => m[1] !== carYesRef)?.[1]
        ?? insuranceYesMatches[insuranceYesMatches.length - 1]?.[1];

      const extra: Record<string, any> = {
        'Car fields initially visible': carFieldsInitially,
        'Car fields after Yes': carFieldsAfterYes,
      };
      if (condition === 'B' && workspaceDir) {
        const diffsDir = path.join(workspaceDir, '.playwright-mcp', 'browser-state', 'diffs');
        const exists = await fs.promises.access(diffsDir).then(() => true).catch(() => false);
        if (exists) {
          const diffs = (await fs.promises.readdir(diffsDir)).sort();
          if (diffs.length > 0) {
            const lastDiff = await fs.promises.readFile(path.join(diffsDir, diffs[diffs.length - 1]), 'utf-8');
            extra['Diff shows Car Make'] = lastDiff.includes('car_make') || lastDiff.includes('Car Make');
          }
        }
      }

      // Fill car details
      const fill1 = await client.callTool({
        name: 'browser_fill_form',
        arguments: {
          fields: [
            { name: 'Car Make', type: 'textbox', ref: carMakeRef, value: 'Toyota' },
            { name: 'Car Year', type: 'textbox', ref: carYearRef, value: '2020' },
          ],
        },
      });
      m.toolCalls++; m.totalResponseSize += txt(fill1).length;

      // Click "Yes" for insurance → reveals insurance provider
      const r2 = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Insurance Yes radio', ref: insuranceYesRef! },
      });
      m.toolCalls++; m.totalResponseSize += txt(r2).length;
      const afterInsYes = txt(r2);

      // Extract insurance provider ref from the click response
      const providerRef = extractRef(afterInsYes, /Insurance Provider.*\[ref=(e\d+)\]/);

      // Fill provider (no submit:true to avoid auto-submitting)
      const r3 = await client.callTool({
        name: 'browser_type',
        arguments: { element: 'Insurance Provider', ref: providerRef, text: 'State Farm' },
      });
      m.toolCalls++; m.totalResponseSize += txt(r3).length;

      // Submit
      const submit = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Submit Survey', ref: submitRef },
      });
      m.toolCalls++; m.totalResponseSize += txt(submit).length;

      m.completed = txt(submit).includes('successfully') || txt(submit).includes('Thank you');
      m.domState = await checkDomState(workspaceDir);
      logMetrics('Task 6: Dynamic Form', condition, m, extra);

      expect(m.completed).toBe(true);
      if (condition === 'B') {
        expect(m.domState?.diffCount).toBeGreaterThanOrEqual(2);
      }
    });
  }

  // ── Task 7: Complex Nested Layout ─────────────────────────────────

  for (const condition of ['A', 'B'] as const) {
    test(`Task 7: Nested Fieldsets — Condition ${condition}`, async ({ startClient, server }) => {
      server.setContent('/eval/07', loadTestPage('07-nested-fieldsets.html'), 'text/html');
      const { client, workspaceDir } = await setupClient(startClient, condition);
      const m: Metrics = { toolCalls: 0, errors: 0, completed: false, totalResponseSize: 0, domState: null };

      // Navigate
      const nav = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + 'eval/07' } });
      m.toolCalls++; m.totalResponseSize += txt(nav).length;
      let t = txt(nav);

      // The aria tree should show fieldset groups with legends
      const ariaShowsFieldsets = t.includes('Personal Information') && t.includes('Emergency Contact');

      // Extract refs — need to distinguish between duplicate field names
      // The aria tree shows them in fieldset groups, so we match by context
      // All "First Name" refs, "Phone" refs, "Email" refs in order (personal first, emergency second)
      const firstNameRef = extractRef(t, /Personal.*[\s\S]*?First Name.*\[ref=(e\d+)\]/);
      const lastNameRef = extractRef(t, /Personal.*[\s\S]*?Last Name.*\[ref=(e\d+)\]/);

      // Get Phone and Email refs in order — personal first, then emergency
      const phoneMatches = [...t.matchAll(/Phone.*\[ref=(e\d+)\]/g)];
      const emailMatches = [...t.matchAll(/Email.*\[ref=(e\d+)\]/g)];
      const personalPhoneRef = phoneMatches[0][1];
      const personalEmailRef = emailMatches[0][1];
      const emergencyPhoneRef = phoneMatches[1][1];
      const emergencyEmailRef = emailMatches[1][1];

      const contactNameRef = extractRef(t, /Contact Name.*\[ref=(e\d+)\]/);
      const relationshipRef = extractRef(t, /Relationship.*\[ref=(e\d+)\]/);
      const bloodTypeRef = extractRef(t, /Blood Type.*\[ref=(e\d+)\]/);
      const allergiesRef = extractRef(t, /Allergies.*\[ref=(e\d+)\]/);
      const submitRef = extractRef(t, /Submit Contact.*\[ref=(e\d+)\]/);

      // Fill Personal section
      const fill1 = await client.callTool({
        name: 'browser_fill_form',
        arguments: {
          fields: [
            { name: 'First Name', type: 'textbox', ref: firstNameRef, value: 'Morgan' },
            { name: 'Last Name', type: 'textbox', ref: lastNameRef, value: 'Lee' },
            { name: 'Phone', type: 'textbox', ref: personalPhoneRef, value: '(555) 111-2222' },
            { name: 'Email', type: 'textbox', ref: personalEmailRef, value: 'morgan.lee@example.com' },
          ],
        },
      });
      m.toolCalls++; m.totalResponseSize += txt(fill1).length;

      // Fill Emergency section
      const fill2 = await client.callTool({
        name: 'browser_fill_form',
        arguments: {
          fields: [
            { name: 'Contact Name', type: 'textbox', ref: contactNameRef, value: 'Sam Lee' },
            { name: 'Phone', type: 'textbox', ref: emergencyPhoneRef, value: '(555) 333-4444' },
            { name: 'Email', type: 'textbox', ref: emergencyEmailRef, value: 'sam.lee@example.com' },
          ],
        },
      });
      m.toolCalls++; m.totalResponseSize += txt(fill2).length;

      // Select relationship
      const selRel = await client.callTool({
        name: 'browser_select_option',
        arguments: { element: 'Relationship', ref: relationshipRef, values: ['sibling'] },
      });
      m.toolCalls++; m.totalResponseSize += txt(selRel).length;

      // Select blood type
      const selBlood = await client.callTool({
        name: 'browser_select_option',
        arguments: { element: 'Blood Type', ref: bloodTypeRef, values: ['O+'] },
      });
      m.toolCalls++; m.totalResponseSize += txt(selBlood).length;

      // Fill allergies (no submit:true to avoid auto-submitting)
      const typeAllergies = await client.callTool({
        name: 'browser_type',
        arguments: { element: 'Allergies', ref: allergiesRef, text: 'None' },
      });
      m.toolCalls++; m.totalResponseSize += txt(typeAllergies).length;

      // Submit explicitly
      const submit = await client.callTool({
        name: 'browser_click',
        arguments: { element: 'Submit Contact Information', ref: submitRef },
      });
      m.toolCalls++; m.totalResponseSize += txt(submit).length;

      m.completed = txt(submit).includes('successfully') || txt(submit).includes('saved');
      m.domState = await checkDomState(workspaceDir);

      const extra: Record<string, any> = {
        'Aria shows fieldsets': ariaShowsFieldsets,
        'Phone refs distinct': personalPhoneRef !== emergencyPhoneRef,
      };
      if (condition === 'B' && workspaceDir) {
        const domPath = path.join(workspaceDir, '.playwright-mcp', 'browser-state', 'dom.html');
        const domExists = await fs.promises.access(domPath).then(() => true).catch(() => false);
        if (domExists) {
          const dom = await fs.promises.readFile(domPath, 'utf-8');
          extra['Fieldsets in DOM'] = dom.includes('<fieldset');
          extra['Legends in DOM'] = dom.includes('<legend');
          extra['Phone fields in DOM'] = (dom.match(/name=".*phone.*"/gi) || []).length;
        }
      }
      logMetrics('Task 7: Nested Fieldsets', condition, m, extra);

      expect(m.completed).toBe(true);
      if (condition === 'B') {
        expect(m.domState?.domExists).toBe(true);
      }
    });
  }
});
