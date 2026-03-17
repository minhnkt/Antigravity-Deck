// === Agent Session Manager ===
// Registry for concurrent AgentSession instances.
// Handles creation, lookup, destruction, idle timeout, and max session limits.

const crypto = require('crypto');
const { AgentSession } = require('./agent-session');
const { resolveLsInst } = require('./ls-utils');

const sessions = new Map(); // sessionId → AgentSession
let _config = {
    maxConcurrentSessions: 5,
    sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
    defaultStepSoftLimit: 500,
};
let _cleanupTimer = null;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new agent session.
 * @param {object} opts
 * @param {string} [opts.workspace]     - Workspace name
 * @param {string} [opts.cascadeId]     - Existing cascade to resume
 * @param {number} [opts.stepSoftLimit] - Step limit override
 * @param {object} [opts.lsInst]        - LS instance { port, csrfToken, useTls }
 * @param {string} [opts.transport]     - Transport label ('discord', 'ws', 'http')
 * @returns {AgentSession}
 */
function createSession(opts = {}) {
    if (sessions.size >= _config.maxConcurrentSessions) {
        // Try to evict oldest idle session
        const evicted = _evictIdlest();
        if (!evicted) {
            throw new Error(`Max concurrent sessions reached (${_config.maxConcurrentSessions})`);
        }
    }

    const id = crypto.randomUUID();
    const session = new AgentSession(id, {
        workspace: opts.workspace,
        cascadeId: opts.cascadeId,
        stepSoftLimit: opts.stepSoftLimit || _config.defaultStepSoftLimit,
        lsInst: opts.lsInst || resolveLsInst(opts.workspace),
        transport: opts.transport || 'unknown',
        persist: () => {}, // sessions are in-memory; override if needed
    });

    sessions.set(id, session);

    session.on('destroyed', () => {
        sessions.delete(id);
        _broadcast('session_destroyed', { sessionId: id });
    });

    _broadcast('session_created', { sessionId: id, ...session.getStatus() });

    // Start cleanup timer if not running
    if (!_cleanupTimer) {
        _cleanupTimer = setInterval(_cleanupIdleSessions, 60000); // check every minute
    }

    return session;
}

/**
 * Get session by ID.
 * @param {string} sessionId
 * @returns {AgentSession|null}
 */
function getSession(sessionId) {
    return sessions.get(sessionId) || null;
}

/**
 * Destroy a session by ID.
 * @param {string} sessionId
 */
function destroySession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.destroy(); // 'destroyed' event listener handles sessions.delete + broadcast
    }
}

/**
 * List all active sessions.
 * @returns {Array<object>}
 */
function listSessions() {
    return Array.from(sessions.values()).map(s => s.getStatus());
}

/**
 * Update manager configuration.
 * @param {object} config
 */
function configure(config) {
    if (config.maxConcurrentSessions != null) _config.maxConcurrentSessions = config.maxConcurrentSessions;
    if (config.sessionTimeoutMs != null) _config.sessionTimeoutMs = config.sessionTimeoutMs;
    if (config.defaultStepSoftLimit != null) _config.defaultStepSoftLimit = config.defaultStepSoftLimit;
}

/**
 * Destroy all sessions and stop cleanup timer.
 */
function shutdownAll() {
    for (const session of sessions.values()) {
        session.destroy();
    }
    sessions.clear();
    if (_cleanupTimer) {
        clearInterval(_cleanupTimer);
        _cleanupTimer = null;
    }
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _cleanupIdleSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (!session.isBusy && (now - session.lastActivity) > _config.sessionTimeoutMs) {
            console.log(`[SessionManager] Idle timeout — destroying session ${id.substring(0, 8)}`);
            session.destroy(); // 'destroyed' event listener handles sessions.delete + broadcast
        }
    }
    // Stop timer if no sessions
    if (sessions.size === 0 && _cleanupTimer) {
        clearInterval(_cleanupTimer);
        _cleanupTimer = null;
    }
}

function _evictIdlest() {
    let oldest = null;
    let oldestTime = Infinity;
    for (const [id, session] of sessions) {
        if (!session.isBusy && session.lastActivity < oldestTime) {
            oldest = id;
            oldestTime = session.lastActivity;
        }
    }
    if (oldest) {
        console.log(`[SessionManager] Evicting idle session ${oldest.substring(0, 8)}`);
        const session = sessions.get(oldest);
        session.destroy(); // 'destroyed' event listener handles sessions.delete + broadcast
        return true;
    }
    return false;
}

function _broadcast(event, data) {
    try {
        const { broadcastAll } = require('./ws');
        broadcastAll({ type: 'agent_sessions', event, ...data });
    } catch { /* ws not ready */ }
}

module.exports = {
    createSession, getSession, destroySession,
    listSessions, configure, shutdownAll,
};
