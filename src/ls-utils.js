// === LS Instance Utilities ===
// Shared helper for resolving Language Server instances by workspace name.
// Previously duplicated across ws-agent.js, agent-api.js, and agent-session-manager.js.

/**
 * Resolve a Language Server instance by workspace name.
 * @param {string} workspace - Workspace name to look up
 * @returns {{ port: number, csrfToken: string, useTls: boolean } | null}
 */
function resolveLsInst(workspace) {
    if (!workspace) return null;
    try {
        const { lsInstances } = require('./config');
        const match = lsInstances.find(
            i => i.workspaceName.toLowerCase() === workspace.toLowerCase()
        );
        if (match) {
            return { port: match.port, csrfToken: match.csrfToken, useTls: match.useTls };
        }
    } catch { /* config not ready */ }
    return null;
}

module.exports = { resolveLsInst };
