"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthManager = void 0;
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
class AuthManager {
    authDir;
    constructor(authDir) {
        this.authDir = authDir;
    }
    async exportState(instance, savePath) {
        let outputPath;
        if (savePath) {
            // Validate savePath is within the configured auth directory to prevent path traversal.
            // Resolve both paths to canonical absolute paths before comparing so that relative
            // segments like "../../../etc" are fully collapsed before the check.
            const resolved = node_path_1.default.resolve(savePath);
            const authDirResolved = node_path_1.default.resolve(this.authDir);
            // Allow the path to equal authDir exactly, or to be a file inside it.
            // The `+ path.sep` suffix prevents a prefix like `/home/user/.auth-evil`
            // from passing a naive startsWith check against `/home/user/.auth`.
            if (resolved !== authDirResolved && !resolved.startsWith(authDirResolved + node_path_1.default.sep)) {
                throw new Error(`savePath must be within the auth directory (${this.authDir}). Got: ${savePath}`);
            }
            outputPath = resolved;
        }
        else {
            outputPath = await this.generateOutputPath(instance.id);
        }
        await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(outputPath), { recursive: true });
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
            const content = await node_fs_1.default.promises.readFile(outputPath, 'utf-8');
            JSON.parse(content); // validate it's valid JSON
        }
        catch (error) {
            throw new Error(`Failed to export storage state: file was not written or is invalid (${error instanceof Error ? error.message : String(error)})`);
        }
        // Set restrictive permissions
        await node_fs_1.default.promises.chmod(outputPath, 0o600);
        return outputPath;
    }
    async generateOutputPath(instanceId) {
        await node_fs_1.default.promises.mkdir(this.authDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        return node_path_1.default.join(this.authDir, `state-${instanceId}-${timestamp}.json`);
    }
}
exports.AuthManager = AuthManager;
//# sourceMappingURL=auth-manager.js.map