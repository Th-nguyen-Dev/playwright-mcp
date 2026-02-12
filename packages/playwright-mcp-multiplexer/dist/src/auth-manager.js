import path from 'node:path';
import fs from 'node:fs';
export class AuthManager {
    authDir;
    constructor(authDir) {
        this.authDir = authDir;
    }
    async exportState(instance, savePath) {
        const outputPath = savePath ?? await this.generateOutputPath(instance.id);
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        // Use browser_run_code with storageState({ path }) to save directly to file.
        // This is the most reliable method — Playwright writes the JSON file directly.
        const escapedPath = outputPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        await instance.client.callTool({
            name: 'browser_run_code',
            arguments: {
                code: `await page.context().storageState({ path: '${escapedPath}' })`,
            },
        });
        // Verify the file was written
        try {
            const content = await fs.promises.readFile(outputPath, 'utf-8');
            JSON.parse(content); // validate it's valid JSON
        }
        catch (error) {
            throw new Error(`Failed to export storage state: file was not written or is invalid (${error instanceof Error ? error.message : String(error)})`);
        }
        // Set restrictive permissions
        await fs.promises.chmod(outputPath, 0o600);
        return outputPath;
    }
    async generateOutputPath(instanceId) {
        await fs.promises.mkdir(this.authDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        return path.join(this.authDir, `state-${instanceId}-${timestamp}.json`);
    }
}
//# sourceMappingURL=auth-manager.js.map