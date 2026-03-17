// === WebSocket Agent Protocol ===
// Dedicated WebSocket endpoint for external AI agents at /ws/agent.
// Separate from the UI WebSocket at /ws to avoid mixing concerns.
//
// Protocol:
//   Client → Server: connect, send, status, switch_workspace, disconnect
//   Server → Client: connected, response, busy, cascade_transition, log, error

const crypto = require('crypto');
const sessionManager = require('./agent-session-manager');
const { resolveLsInst } = require('./ls-utils');

/**
 * Set up the agent WebSocket server.
 * @param {import('ws').WebSocketServer} agentWss
 */
function setupAgentWebSocket(agentWss) {
    agentWss.on('connection', (ws, req) => {
        // Auth check (same pattern as ws.js)
        const authKey = process.env.AUTH_KEY || '';
        if (authKey) {
            const ip = req.socket.remoteAddress || '';
            const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
            if (!isLocal) {
                const url = new URL(req.url, 'http://localhost');
                const key = url.searchParams.get('auth_key');
                if (key !== authKey) {
                    ws.close(4401, 'Unauthorized');
                    return;
                }
            }
        }

        let session = null;
        console.log('[WS-Agent] New connection');

        ws.on('message', async (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                _send(ws, { type: 'error', message: 'Invalid JSON' });
                return;
            }

            try {
                switch (msg.type) {
                    case 'connect': {
                        if (session) {
                            _send(ws, { type: 'error', message: 'Already connected — disconnect first' });
                            break;
                        }

                        session = sessionManager.createSession({
                            workspace: msg.workspace,
                            cascadeId: msg.cascadeId,
                            stepSoftLimit: msg.stepSoftLimit,
                            transport: 'websocket',
                        });

                        // Wire session events → WebSocket messages
                        _wireSessionEvents(ws, session);

                        _send(ws, {
                            type: 'connected',
                            sessionId: session.id,
                            cascadeId: session.cascadeId,
                            workspace: session.workspace,
                        });

                        console.log(`[WS-Agent] Connected: session=${session.id.substring(0, 8)}, workspace=${session.workspace}`);
                        break;
                    }

                    case 'send': {
                        if (!session) {
                            _send(ws, { type: 'error', message: 'Not connected — send "connect" first' });
                            break;
                        }

                        if (!msg.message) {
                            _send(ws, { type: 'error', message: 'Missing "message" field' });
                            break;
                        }

                        // sendMessage is blocking — runs async, sends response event when done
                        const result = await session.sendMessage(msg.message, {
                            action: msg.action || null,
                            authorName: msg.authorName || null,
                        });

                        // Response already emitted via session event → _wireSessionEvents handles it
                        // But also send explicit completion for agents that prefer request/response style
                        if (!result.text && result.busy) {
                            _send(ws, { type: 'busy_rejected', message: 'Session is busy processing a previous message' });
                        }
                        break;
                    }

                    case 'status': {
                        if (!session) {
                            _send(ws, { type: 'error', message: 'Not connected' });
                            break;
                        }
                        _send(ws, { type: 'status', ...session.getStatus() });
                        break;
                    }

                    case 'switch_workspace': {
                        if (!session) {
                            _send(ws, { type: 'error', message: 'Not connected' });
                            break;
                        }

                        const lsInst = resolveLsInst(msg.workspace);
                        await session.switchWorkspace(msg.workspace, lsInst);
                        _send(ws, {
                            type: 'workspace_switched',
                            workspace: session.workspace,
                            cascadeId: session.cascadeId,
                        });
                        break;
                    }

                    case 'accept': {
                        if (!session) { _send(ws, { type: 'error', message: 'Not connected' }); break; }
                        await session.accept();
                        _send(ws, { type: 'accepted' });
                        break;
                    }

                    case 'reject': {
                        if (!session) { _send(ws, { type: 'error', message: 'Not connected' }); break; }
                        await session.reject();
                        _send(ws, { type: 'rejected' });
                        break;
                    }

                    case 'disconnect': {
                        if (session) {
                            console.log(`[WS-Agent] Disconnecting session ${session.id.substring(0, 8)}`);
                            sessionManager.destroySession(session.id);
                            session = null;
                        }
                        _send(ws, { type: 'disconnected' });
                        break;
                    }

                    default:
                        _send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
                }
            } catch (e) {
                _send(ws, { type: 'error', message: e.message });
            }
        });

        ws.on('close', () => {
            if (session) {
                console.log(`[WS-Agent] Connection closed — destroying session ${session.id.substring(0, 8)}`);
                sessionManager.destroySession(session.id);
                session = null;
            }
        });

        ws.on('error', (err) => {
            console.error('[WS-Agent] WebSocket error:', err.message);
        });
    });
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _wireSessionEvents(ws, session) {
    session.on('response', (data) => {
        _send(ws, { type: 'response', ...data });
    });

    session.on('busy_change', (data) => {
        _send(ws, { type: 'busy', ...data });
    });

    session.on('cascade_transition', (data) => {
        _send(ws, { type: 'cascade_transition', ...data });
    });

    session.on('status_change', (data) => {
        _send(ws, { type: 'status_change', state: data.state });
    });

    session.on('step_limit_warning', (data) => {
        _send(ws, { type: 'step_limit_warning', ...data });
    });

    session.on('log', (data) => {
        _send(ws, { type: 'log', logType: data.type, message: data.message });
    });

    session.on('error', (err) => {
        _send(ws, { type: 'error', message: err.message });
    });
}

function _send(ws, data) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

module.exports = { setupAgentWebSocket };
