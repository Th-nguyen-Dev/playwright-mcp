/**
 * Unit tests for InstanceManager.buildArgs()
 *
 * These tests verify that the headless flag is NOT forwarded as a CLI argument
 * to the child @playwright/mcp process. The anti-detection strategy relies on
 * Chrome running in headed mode on an Xvfb virtual display, which is configured
 * via the config file (headless: false) — NOT via the --headless CLI flag.
 */
import { test, expect } from '@playwright/test';
import { InstanceManager } from '../dist/src/instance-manager.js';

// Access private buildArgs via type cast to allow focused unit testing
// without modifying the production API surface.
type InstanceManagerInternal = InstanceManager & {
  buildArgs(instanceId: string, instanceConfig: Record<string, unknown>): Promise<string[]>;
};

test.describe('InstanceManager.buildArgs() — headless flag', () => {
  test('should NOT include --headless in args when headless: true (uses Xvfb instead)', async () => {
    const manager = new InstanceManager({
      defaultHeadless: true,
      cliPath: '/dev/null', // not spawning, just checking args
    }) as InstanceManagerInternal;

    const args = await manager.buildArgs('inst-test', { headless: true });

    expect(args).not.toContain('--headless');
  });

  test('should NOT include --headless in args when headless: false', async () => {
    const manager = new InstanceManager({
      defaultHeadless: false,
      cliPath: '/dev/null',
    }) as InstanceManagerInternal;

    const args = await manager.buildArgs('inst-test', { headless: false });

    expect(args).not.toContain('--headless');
  });

  test('should NOT include --headless in args when using server default headless: true', async () => {
    const manager = new InstanceManager({
      defaultHeadless: true,
      cliPath: '/dev/null',
    }) as InstanceManagerInternal;

    // instanceConfig has no headless — falls back to defaultHeadless: true
    const args = await manager.buildArgs('inst-test', {});

    expect(args).not.toContain('--headless');
  });

  test('should include --browser and --isolated in args for a headless instance', async () => {
    const manager = new InstanceManager({
      defaultHeadless: true,
      defaultBrowser: 'chrome',
      cliPath: '/dev/null',
    }) as InstanceManagerInternal;

    const args = await manager.buildArgs('inst-test', {});

    expect(args).toContain('--browser=chrome');
    // No userDataDir configured → falls back to --isolated
    expect(args).toContain('--isolated');
    // Config file path is always included
    expect(args.some(a => a.startsWith('--config='))).toBe(true);
  });
});
