import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Files copied from the Chrome Default/ profile for auth fidelity
const PROFILE_FILES = [
    'Cookies', 'Cookies-journal',
    'Login Data', 'Login Data-journal',
    'Web Data', 'Web Data-journal',
    'Preferences', 'Secure Preferences',
    'Extension Cookies',
];
// Directories copied recursively
const PROFILE_DIRS = [
    'Local Storage',
    'Session Storage',
    'IndexedDB',
];
export class InstanceManager {
    instances = new Map();
    profileDirs = new Map(); // instanceId → temp profile root
    configFiles = new Map(); // instanceId → temp config file path
    nextId = 1;
    config;
    workspaceRoot;
    constructor(config = {}) {
        this.config = {
            maxInstances: config.maxInstances ?? 10,
            defaultHeadless: config.defaultHeadless ?? true,
            defaultBrowser: config.defaultBrowser ?? 'chrome',
            authDir: config.authDir ?? path.join(os.homedir(), '.pride-riot', 'auth'),
            cliPath: config.cliPath ?? this.resolveDefaultCliPath(),
            userDataDir: config.userDataDir ?? '',
            profileName: config.profileName ?? 'Default',
        };
    }
    /**
     * Set the workspace root path from the MCP client's roots.
     * Called by the multiplexer server during initialization.
     */
    setWorkspaceRoot(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
    }
    resolveDefaultCliPath() {
        // Resolve the sibling @playwright/mcp package's cli.js
        try {
            const require = createRequire(import.meta.url);
            const mcpPkgPath = require.resolve('@playwright/mcp/package.json');
            return path.join(path.dirname(mcpPkgPath), 'cli.js');
        }
        catch {
            // Fallback: relative path within monorepo
            return path.join(__dirname, '..', '..', 'playwright-mcp', 'cli.js');
        }
    }
    async create(instanceConfig = {}) {
        if (this.instances.size >= this.config.maxInstances) {
            throw new Error(`Maximum number of instances (${this.config.maxInstances}) reached`);
        }
        const id = `inst-${this.nextId++}`;
        const args = await this.buildArgs(id, instanceConfig);
        // Use --storage-state CLI flag directly (no temp config file needed)
        if (instanceConfig.storageState) {
            args.push(`--storage-state=${instanceConfig.storageState}`);
        }
        const instance = {
            id,
            client: null,
            transport: null,
            config: instanceConfig,
            createdAt: Date.now(),
            status: 'starting',
        };
        this.instances.set(id, instance);
        try {
            // Build environment for child process
            const env = {
                ...process.env,
                DEBUG: process.env.DEBUG ?? '',
            };
            // DOM state toggle: explicitly disable or enable per instance
            if (instanceConfig.domState === false) {
                env.PW_DOM_STATE_DISABLED = '1';
            }
            else {
                env.PW_DOM_STATE_INSTANCE_ID = id;
                if (this.workspaceRoot)
                    env.PW_DOM_STATE_WORKSPACE = this.workspaceRoot;
            }
            const transport = new StdioClientTransport({
                command: 'node',
                args: [this.config.cliPath, ...args],
                stderr: 'pipe',
                env,
            });
            const client = new Client({
                name: `multiplexer-${id}`,
                version: '1.0.0',
            });
            instance.transport = transport;
            instance.client = client;
            await client.connect(transport);
            await client.ping();
            instance.status = 'ready';
            return instance;
        }
        catch (error) {
            this.instances.delete(id);
            await this.cleanupProfile(id);
            throw new Error(`Failed to create instance ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    get(id) {
        return this.instances.get(id);
    }
    getOrThrow(id) {
        const instance = this.instances.get(id);
        if (!instance) {
            throw new Error(`Instance "${id}" not found`);
        }
        if (instance.status !== 'ready') {
            throw new Error(`Instance "${id}" is not ready (status: ${instance.status})`);
        }
        return instance;
    }
    list() {
        return Array.from(this.instances.values());
    }
    async close(id) {
        const instance = this.instances.get(id);
        if (!instance) {
            throw new Error(`Instance "${id}" not found`);
        }
        instance.status = 'closed';
        try {
            await instance.client.close();
        }
        catch {
            // Client may already be disconnected
        }
        this.instances.delete(id);
        await this.cleanupProfile(id);
    }
    async closeAll() {
        const ids = Array.from(this.instances.keys());
        await Promise.all(ids.map(id => this.close(id)));
    }
    getConfig() {
        return this.config;
    }
    async buildArgs(instanceId, instanceConfig) {
        const args = [];
        const headless = instanceConfig.headless ?? this.config.defaultHeadless;
        if (headless)
            args.push('--headless');
        const browser = instanceConfig.browser ?? this.config.defaultBrowser;
        if (browser)
            args.push(`--browser=${browser}`);
        // If a userDataDir is configured, copy the profile and use --user-data-dir
        // Otherwise fall back to --isolated for a clean ephemeral profile
        const sourceDir = instanceConfig.userDataDir || this.config.userDataDir;
        if (sourceDir) {
            const profileRoot = await this.copyProfile(instanceId, sourceDir);
            args.push(`--user-data-dir=${profileRoot}`);
        }
        else {
            args.push('--isolated');
        }
        // Set a custom WM_CLASS so window managers can route these windows
        // (e.g. Hyprland windowrule to send them to a dedicated workspace)
        if (!headless) {
            const configPath = await this.createLaunchConfig(instanceId);
            args.push(`--config=${configPath}`);
        }
        if (process.env.CI && process.platform === 'linux')
            args.push('--no-sandbox');
        if (instanceConfig.args)
            args.push(...instanceConfig.args);
        return args;
    }
    async createLaunchConfig(instanceId) {
        const tmpDir = path.join(os.tmpdir(), 'pw-mux');
        await fs.promises.mkdir(tmpDir, { recursive: true });
        const configPath = path.join(tmpDir, `launch-${instanceId}.json`);
        const config = {
            browser: {
                launchOptions: {
                    args: ['--class=pw-mux'],
                },
            },
        };
        await fs.promises.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
        this.configFiles.set(instanceId, configPath);
        return configPath;
    }
    async copyProfile(instanceId, sourceDir) {
        const profileRoot = path.join(os.tmpdir(), 'pw-mux', `profile-${instanceId}`);
        const destDefault = path.join(profileRoot, 'Default');
        const srcDefault = path.join(sourceDir, this.config.profileName);
        await fs.promises.mkdir(destDefault, { recursive: true });
        // Copy individual auth-relevant files
        for (const file of PROFILE_FILES) {
            const src = path.join(srcDefault, file);
            const dest = path.join(destDefault, file);
            try {
                await fs.promises.copyFile(src, dest);
            }
            catch {
                // File may not exist in every profile — skip silently
            }
        }
        // Copy auth-relevant directories recursively
        for (const dir of PROFILE_DIRS) {
            const src = path.join(srcDefault, dir);
            const dest = path.join(destDefault, dir);
            try {
                await fs.promises.cp(src, dest, { recursive: true });
            }
            catch {
                // Directory may not exist — skip silently
            }
        }
        // Also copy the top-level Local State file (needed for encrypted cookie decryption)
        try {
            await fs.promises.copyFile(path.join(sourceDir, 'Local State'), path.join(profileRoot, 'Local State'));
        }
        catch {
            // May not exist
        }
        this.profileDirs.set(instanceId, profileRoot);
        return profileRoot;
    }
    async cleanupProfile(instanceId) {
        const profileDir = this.profileDirs.get(instanceId);
        if (profileDir) {
            this.profileDirs.delete(instanceId);
            try {
                await fs.promises.rm(profileDir, { recursive: true, force: true });
            }
            catch {
                // Best-effort cleanup
            }
        }
        const configFile = this.configFiles.get(instanceId);
        if (configFile) {
            this.configFiles.delete(instanceId);
            await fs.promises.unlink(configFile).catch(() => { });
        }
    }
}
//# sourceMappingURL=instance-manager.js.map