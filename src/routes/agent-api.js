// === Agent API Routes ===
// HTTP REST endpoints for external AI agents.
// /api/agent/* — connect, send (blocking + SSE), status, accept, reject, disconnect

const { z } = require('zod');
const sessionManager = require('../agent-session-manager');
const { resolveLsInst } = require('../ls-utils');

const ConnectSchema = z.object({
    workspace: z.string().max(200).optional(),
    cascadeId: z.string().max(200).optional(),
    stepSoftLimit: z.number().int().min(1).max(10000).optional(),
}).strict();

const SendSchema = z.object({
    message: z.string().min(1).max(100000),
    action: z.enum(['accept', 'reject']).optional(),
    authorName: z.string().max(200).optional(),
}).strict();

const SwitchWorkspaceSchema = z.object({
    workspace: z.string().min(1).max(200),
}).strict();

module.exports = function setupAgentApiRoutes(app) {

    // ── Connect — create a new agent session ─────────────────────────────────

    app.post('/api/agent/connect', (req, res) => {
        try {
            const body = ConnectSchema.parse(req.body || {});

            const session = sessionManager.createSession({
                workspace: body.workspace,
                cascadeId: body.cascadeId,
                stepSoftLimit: body.stepSoftLimit,
                transport: 'http',
            });

            res.json({
                sessionId: session.id,
                cascadeId: session.cascadeId,
                workspace: session.workspace,
                state: session.state,
            });
        } catch (e) {
            if (e instanceof z.ZodError) {
                return res.status(400).json({ error: 'Invalid request', details: e.issues });
            }
            res.status(500).json({ error: e.message });
        }
    });

    // ── Send — send message and wait for response ────────────────────────────

    app.post('/api/agent/:sessionId/send', async (req, res) => {
        const session = sessionManager.getSession(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        let body;
        try {
            body = SendSchema.parse(req.body || {});
        } catch (e) {
            if (e instanceof z.ZodError) {
                return res.status(400).json({ error: 'Invalid request', details: e.issues });
            }
            return res.status(400).json({ error: e.message });
        }

        // Check if client wants SSE streaming
        const wantsSSE = req.headers.accept === 'text/event-stream';

        if (wantsSSE) {
            // SSE mode — stream events as they happen
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });

            const onLog = (data) => {
                res.write(`event: log\ndata: ${JSON.stringify(data)}\n\n`);
            };
            const onBusy = (data) => {
                res.write(`event: busy\ndata: ${JSON.stringify(data)}\n\n`);
            };
            const onTransition = (data) => {
                res.write(`event: cascade_transition\ndata: ${JSON.stringify(data)}\n\n`);
            };

            session.on('log', onLog);
            session.on('busy_change', onBusy);
            session.on('cascade_transition', onTransition);

            try {
                const result = await session.sendMessage(body.message, {
                    action: body.action || null,
                    authorName: body.authorName || null,
                });

                res.write(`event: response\ndata: ${JSON.stringify(result)}\n\n`);
                res.write(`event: done\ndata: {}\n\n`);
            } catch (e) {
                res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
            } finally {
                session.removeListener('log', onLog);
                session.removeListener('busy_change', onBusy);
                session.removeListener('cascade_transition', onTransition);
                res.end();
            }
        } else {
            // Blocking mode — wait for full response
            try {
                const result = await session.sendMessage(body.message, {
                    action: body.action || null,
                    authorName: body.authorName || null,
                });

                if (result.busy) {
                    return res.status(429).json({
                        error: 'Session busy — previous message still processing',
                        ...result,
                    });
                }

                res.json(result);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        }
    });

    // ── Status — get session state ───────────────────────────────────────────

    app.get('/api/agent/:sessionId/status', (req, res) => {
        const session = sessionManager.getSession(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        res.json(session.getStatus());
    });

    // ── Switch workspace ─────────────────────────────────────────────────────

    app.post('/api/agent/:sessionId/switch-workspace', async (req, res) => {
        const session = sessionManager.getSession(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        try {
            const body = SwitchWorkspaceSchema.parse(req.body || {});
            const lsInst = resolveLsInst(body.workspace);
            await session.switchWorkspace(body.workspace, lsInst);
            res.json({
                workspace: session.workspace,
                cascadeId: session.cascadeId,
            });
        } catch (e) {
            if (e instanceof z.ZodError) {
                return res.status(400).json({ error: 'Invalid request', details: e.issues });
            }
            res.status(500).json({ error: e.message });
        }
    });

    // ── Accept / Reject pending code changes ─────────────────────────────────

    app.post('/api/agent/:sessionId/accept', async (req, res) => {
        const session = sessionManager.getSession(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        try {
            await session.accept();
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/agent/:sessionId/reject', async (req, res) => {
        const session = sessionManager.getSession(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        try {
            await session.reject();
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Disconnect — destroy session ─────────────────────────────────────────

    app.delete('/api/agent/:sessionId', (req, res) => {
        const session = sessionManager.getSession(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        sessionManager.destroySession(req.params.sessionId);
        res.json({ ok: true });
    });

    // ── List all active sessions ─────────────────────────────────────────────

    app.get('/api/agent/sessions', (req, res) => {
        res.json({ sessions: sessionManager.listSessions() });
    });
};
