// === Agent Bridge (Discord Transport) ===
// Discord-specific transport layer for agent ↔ cascade interaction.
// Uses AgentSession for orchestration — transport-agnostic cascade lifecycle.
//
// Discord Commands (no @mention needed):
//   /help           — show available commands
//   /listws         — list workspaces under defaultWorkspaceRoot
//   /setws <name>   — set active workspace; creates new cascade if bridge active
//
// Regular messages (@mention required in guild):
//   Relayed to Antigravity cascade. Antigravity NOTIFY_USER → forwarded to Discord.

const fs = require('fs');
const path = require('path');
const discord = require('./discord-relay');
const { getSettings, saveSettings, getBridgeSettings, saveBridgeSettings } = require('./config');
const sessionManager = require('./agent-session-manager');

// ── State ────────────────────────────────────────────────────────────────────

const STATES = { IDLE: 'IDLE', ACTIVE: 'ACTIVE', TRANSITIONING: 'TRANSITIONING' };

let state = STATES.IDLE;
let softLimit = 500;
let workspaceName = 'AntigravityAuto';
let log = [];
let bridgeLsInst = null;
let session = null; // AgentSession instance — owns cascade lifecycle

// ── Persist bridge state to settings.json ────────────────────────────────────

function saveBridgeState() {
    if (!session) return;
    saveBridgeSettings({
        currentWorkspace: workspaceName,
        lastCascadeId: session.cascadeId,
        lastStepCount: session.stepCount,
    });
}

// ── Public API ───────────────────────────────────────────────────────────────

async function startBridge(config = {}) {
    if (state !== STATES.IDLE) {
        throw new Error(`Bridge already ${state}`);
    }

    const bs = getBridgeSettings();

    const token = config.discordBotToken || bs.discordBotToken;
    const channelId = config.discordChannelId || bs.discordChannelId;
    softLimit = config.stepSoftLimit || bs.stepSoftLimit || 500;

    // Load last-used workspace from bridge settings
    workspaceName = bs.currentWorkspace
        || config.workspaceName
        || 'AntigravityAuto';

    // Find the LS instance matching the workspace and bind bridgeLsInst
    const { lsInstances } = require('./config');
    const matchInst = lsInstances.find(
        i => i.workspaceName.toLowerCase() === workspaceName.toLowerCase()
    );
    if (matchInst) {
        bridgeLsInst = { port: matchInst.port, csrfToken: matchInst.csrfToken, useTls: matchInst.useTls };
        addLog('system', `Bound to LS instance: ${workspaceName} (port ${matchInst.port})`);
    } else {
        addLog('system', `No LS instance found for workspace "${workspaceName}" — using global fallback`);
    }

    if (!token) throw new Error('Missing discordBotToken');
    if (!channelId) throw new Error('Missing discordChannelId');

    // Create AgentSession for cascade orchestration
    const sessionOpts = {
        workspace: workspaceName,
        stepSoftLimit: softLimit,
        lsInst: bridgeLsInst,
        transport: 'discord',
        persist: () => saveBridgeState(),
    };

    // Restore cascade from previous session if available
    if (config.cascadeId && config.cascadeId.trim()) {
        sessionOpts.cascadeId = config.cascadeId.trim();
        addLog('system', `Locking to cascade: ${shortId(sessionOpts.cascadeId)}`);
    } else {
        // Try to restore from bridge settings
        if (bs.lastCascadeId) {
            sessionOpts.cascadeId = bs.lastCascadeId;
            addLog('system', `Restored previous cascade: ${shortId(bs.lastCascadeId)} (${bs.lastStepCount || 0} steps)`);
        } else {
            addLog('system', 'Auto-follow mode: will create cascade on first message');
        }
    }

    session = sessionManager.createSession(sessionOpts);

    // Wire session events → Discord messages + bridge log
    session.on('log', ({ type, message }) => addLog(type, message));

    session.on('cascade_transition', (info) => {
        discord.sendMessage(discord.formatCascadeSwitch({
            oldShort: info.oldShort,
            newShort: info.newShort,
            stepCount: info.oldStepCount || info.stepCount,
        })).catch(e => addLog('error', `Transition notice error: ${e.message}`));

        if (info.reason) {
            discord.sendMessage(discord.formatBridgeStatus(
                `New cascade #${info.newShort} for workspace \`${workspaceName}\` — please re-inject context`
            )).catch(() => {});
        }
    });

    session.on('step_limit_warning', ({ stepCount: sc, softLimit: sl }) => {
        discord.sendMessage(discord.formatBridgeStatus(
            `⚠️ Cascade #${shortId(session.cascadeId)} at ${sc}/${sl} steps — will auto-transition soon`
        )).catch(() => {});
    });

    // Discord bot setup
    const eventHook = (event, data) => {
        if (event === 'error') addLog('error', `Discord: ${data.message}`);
        if (event === 'update') addLog('system', `Discord msg from @${data.from}: "${data.text}"`);
        if (event === 'reply') addLog('system', `Discord reply processed: action=${data.action}`);
        if (event === 'command') addLog('system', `Discord command: /${data.command} from @${data.from}`);
        if (event === 'listening') addLog('system', `Discord WS active on channel ${data.channelId}`);
        if (event === 'ready') addLog('system', `Discord bot ready: ${data.tag}`);
        if (event === 'ignored') addLog('system', `Discord ignored: "${data.text}"`);
    };

    const guildId = config.discordGuildId || bs.discordGuildId || '';
    await discord.init(token, channelId, guildId, eventHook);
    discord.startListening(handlePiReply, handleCommand);

    state = STATES.ACTIVE;
    addLog('system', `Bridge ACTIVE — workspace: ${workspaceName}, limit: ${softLimit}`);

    await discord.sendMessage(discord.formatBridgeStatus(
        `Bridge ACTIVE\n` +
        `**Workspace:** \`${workspaceName}\`\n` +
        `**Cascade limit:** ${softLimit} steps\n` +
        `Type \`/help\` for commands`
    )).catch(e => addLog('error', `Discord init msg error: ${e.message}`));

    return getStatus();
}

function stopBridge() {
    if (state === STATES.IDLE) return;
    discord.stop().catch(() => {});
    if (session) {
        sessionManager.destroySession(session.id);
        session = null;
    }
    state = STATES.IDLE;
    addLog('system', 'Bridge stopped');
}

function getStatus() {
    return {
        state,
        cascadeId: session?.cascadeId || null,
        cascadeIdShort: shortId(session?.cascadeId),
        stepCount: session?.stepCount || 0,
        softLimit,
        workspaceName,
        log: log.slice(-50),
    };
}

// ── Discord Command Handler ───────────────────────────────────────────────────

async function handleCommand(cmd, args, replyFn) {
    const settings = getSettings();
    const wsRoot = settings.defaultWorkspaceRoot || '';
    const { lsInstances } = require('./config');

    switch (cmd) {
        case 'help': {
            await replyFn([
                '📖 **Agent Bridge Commands**',
                '```',
                '/help              — Show this help',
                '/listws            — List running LS instances + folders',
                '/setws <name>      — Switch to workspace (opens if needed)',
                '/createws <name>   — Create new workspace folder + open in Antigravity',
                '```',
                `**Active workspace:** \`${workspaceName}\``,
                `**Cascade:** #${shortId(session?.cascadeId)} (${session?.stepCount || 0}/${softLimit} steps)`,
                `**State:** ${state}`,
            ].join('\n'));
            break;
        }

        case 'listws': {
            const lines = [];
            if (lsInstances.length > 0) {
                lines.push('**🟢 Running (Antigravity open):**');
                lsInstances.forEach(inst => {
                    const activeTag = inst.active ? ' ← LS active' : '';
                    const bridgeTag = inst.workspaceName === workspaceName ? ' 🤖' : '';
                    const bold = inst.active ? '**' : '';
                    lines.push(`${bold}• ${inst.workspaceName}${activeTag}${bridgeTag}${bold}`);
                });
            } else {
                lines.push('*No running Antigravity instances detected*');
            }
            try {
                if (wsRoot && fs.existsSync(wsRoot)) {
                    const running = new Set(lsInstances.map(i => i.workspaceName));
                    const fsWs = fs.readdirSync(wsRoot, { withFileTypes: true })
                        .filter(d => d.isDirectory() && !running.has(d.name))
                        .map(d => d.name).sort();
                    if (fsWs.length > 0) {
                        lines.push('\n**📁 Other folders (not running):**');
                        fsWs.forEach(w => lines.push(`• ${w}`));
                    }
                }
            } catch { /* ignore */ }
            lines.push(`\n*Use \`/setws <name>\` to switch. 🤖 = bridge workspace*`);
            await replyFn(lines.join('\n'));
            break;
        }

        case 'setws': {
            const newWs = args[0] || '';
            if (!newWs.trim()) {
                await replyFn(`❌ Usage: \`/setws <workspace_name>\`\nCurrent: \`${workspaceName}\``);
                break;
            }

            const matchIdx = lsInstances.findIndex(
                i => i.workspaceName.toLowerCase() === newWs.toLowerCase()
            );

            if (matchIdx >= 0) {
                const { cleanupAll } = require('./cleanup');
                cleanupAll();
                bridgeLsInst = { port: lsInstances[matchIdx].port, csrfToken: lsInstances[matchIdx].csrfToken, useTls: lsInstances[matchIdx].useTls };
                workspaceName = lsInstances[matchIdx].workspaceName;
                addLog('system', `Switched LS → ${workspaceName} (port: ${lsInstances[matchIdx].port})`);
                saveBridgeSettings({ currentWorkspace: workspaceName });

                if (session && (state === STATES.ACTIVE || state === STATES.TRANSITIONING)) {
                    await replyFn(`✅ Switched to \`${workspaceName}\` (port ${lsInstances[matchIdx].port})\n🔄 Starting new cascade...`);
                    await session.switchWorkspace(workspaceName, bridgeLsInst);
                } else {
                    await replyFn(`✅ Switched to \`${workspaceName}\` — ready`);
                }
                break;
            }

            // Not running — open in Antigravity IDE
            await replyFn(`⏳ Opening \`${newWs}\` in Antigravity... (waiting up to 30s)`);
            addLog('system', `Opening workspace: ${newWs}`);

            const { PORT } = require('./config');
            const authKey = process.env.AUTH_KEY || '';
            const headers = { 'Content-Type': 'application/json' };
            if (authKey) headers['X-Auth-Key'] = authKey;

            let createResult;
            try {
                const res = await fetch(`http://localhost:${PORT}/api/workspaces/create`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: newWs }),
                    signal: AbortSignal.timeout(35000),
                });
                createResult = await res.json();
            } catch (e) {
                await replyFn(`❌ Failed to open workspace: ${e.message}`);
                break;
            }

            if (createResult.error) {
                await replyFn(`❌ ${createResult.error}`);
                break;
            }

            const newIdx = lsInstances.findIndex(
                i => i.workspaceName.toLowerCase() === newWs.toLowerCase()
            );
            if (newIdx >= 0) {
                bridgeLsInst = { port: lsInstances[newIdx].port, csrfToken: lsInstances[newIdx].csrfToken, useTls: lsInstances[newIdx].useTls };
                workspaceName = lsInstances[newIdx].workspaceName;
            } else if (createResult.workspace?.workspaceName) {
                const fallbackIdx = lsInstances.findIndex(
                    i => i.workspaceName.toLowerCase() === createResult.workspace.workspaceName.toLowerCase()
                );
                if (fallbackIdx >= 0) {
                    bridgeLsInst = { port: lsInstances[fallbackIdx].port, csrfToken: lsInstances[fallbackIdx].csrfToken, useTls: lsInstances[fallbackIdx].useTls };
                }
                workspaceName = createResult.workspace.workspaceName;
            } else {
                workspaceName = newWs;
            }

            saveBridgeSettings({ currentWorkspace: workspaceName });
            addLog('system', `Workspace opened: ${workspaceName}`);

            if (session && (state === STATES.ACTIVE || state === STATES.TRANSITIONING)) {
                await replyFn(`✅ \`${workspaceName}\` opened — starting new cascade...`);
                await session.switchWorkspace(workspaceName, bridgeLsInst);
            } else {
                await replyFn(`✅ \`${workspaceName}\` is ready`);
            }
            break;
        }

        case 'createws': {
            const newWsName = args[0] || '';
            if (!newWsName.trim()) {
                await replyFn(`❌ Usage: \`/createws <workspace_name>\``);
                break;
            }

            await replyFn(`⏳ Creating \`${newWsName}\` and opening in Antigravity... (waiting up to 30s)`);
            addLog('system', `Creating workspace: ${newWsName}`);

            const { PORT: CREATE_PORT } = require('./config');
            const { lsInstances: lsInst2 } = require('./config');
            const createAuthKey = process.env.AUTH_KEY || '';
            const createHeaders = { 'Content-Type': 'application/json' };
            if (createAuthKey) createHeaders['X-Auth-Key'] = createAuthKey;

            let result;
            try {
                const res = await fetch(`http://localhost:${CREATE_PORT}/api/workspaces/create`, {
                    method: 'POST',
                    headers: createHeaders,
                    body: JSON.stringify({ name: newWsName }),
                    signal: AbortSignal.timeout(35000),
                });
                result = await res.json();
            } catch (e) {
                await replyFn(`❌ Failed: ${e.message}`);
                break;
            }

            if (result.error) {
                await replyFn(`❌ ${result.error}`);
                break;
            }

            if (result.alreadyOpen) {
                await replyFn(`ℹ️ Workspace \`${newWsName}\` already open — use \`/setws ${newWsName}\` to switch`);
                break;
            }

            const newIdx2 = lsInst2.findIndex(i => i.workspaceName.toLowerCase() === newWsName.toLowerCase());
            if (newIdx2 >= 0) {
                bridgeLsInst = { port: lsInst2[newIdx2].port, csrfToken: lsInst2[newIdx2].csrfToken, useTls: lsInst2[newIdx2].useTls };
                workspaceName = lsInst2[newIdx2].workspaceName;
            } else if (result.workspace?.workspaceName) {
                const fallbackIdx2 = lsInst2.findIndex(
                    i => i.workspaceName.toLowerCase() === result.workspace.workspaceName.toLowerCase()
                );
                if (fallbackIdx2 >= 0) {
                    bridgeLsInst = { port: lsInst2[fallbackIdx2].port, csrfToken: lsInst2[fallbackIdx2].csrfToken, useTls: lsInst2[fallbackIdx2].useTls };
                }
                workspaceName = result.workspace.workspaceName;
            } else {
                workspaceName = newWsName;
            }

            saveBridgeSettings({ currentWorkspace: workspaceName });
            addLog('system', `Workspace created + opened: ${workspaceName}`);

            if (session && (state === STATES.ACTIVE || state === STATES.TRANSITIONING)) {
                await replyFn(`✅ \`${workspaceName}\` created — starting new cascade...`);
                await session.switchWorkspace(workspaceName, bridgeLsInst);
            } else {
                await replyFn(`✅ \`${workspaceName}\` created and ready`);
            }
            break;
        }

        default:
            await replyFn(`❓ Unknown command \`/${cmd}\`. Type \`/help\` for available commands.`);
    }
}

// ── Handle Pi's reply from Discord ───────────────────────────────────────────
// Now delegates to AgentSession for all cascade orchestration.

async function handlePiReply({ reply, action, authorId, authorName }) {
    if (state !== STATES.ACTIVE && state !== STATES.TRANSITIONING) return;
    if (!session) return;

    // Busy gate — handled by session, but give Discord-specific feedback
    if (session.isBusy) {
        addLog('system', 'Bridge busy — waiting for response relay. Message blocked.');
        await discord.sendMessage(discord.formatBridgeStatus(
            `⚠️ Agent đang xử lý, hãy chờ response rồi gửi lại message nhé`
        )).catch(() => {});
        return;
    }

    addLog('from_pi', (authorName ? `${authorName}: ` : '') + reply.substring(0, 200));

    // Show "typing..." in Discord while waiting for response
    discord.sendTyping();
    const typingInterval = setInterval(() => discord.sendTyping(), 8000);

    // Delegate to AgentSession — blocking call
    const result = await session.sendMessage(reply, {
        action: action || null,
        authorName: authorName || null,
    });

    clearInterval(typingInterval);

    if (result.text) {
        // Send response to Discord
        try {
            await discord.sendResponse({
                workspaceName,
                cascadeIdShort: shortId(session.cascadeId),
                stepCount: result.stepCount,
                softLimit,
                content: result.text,
                mentionUserId: authorId,
                mentionUserName: authorName,
            });
        } catch (e) {
            addLog('error', `Discord send failed: ${e.message}`);
        }
    } else if (result.busy) {
        await discord.sendMessage(discord.formatBridgeStatus(
            `⚠️ Agent đang xử lý, hãy chờ response rồi gửi lại message nhé`
        )).catch(() => {});
    } else {
        addLog('system', 'Response extraction failed or timeout');
    }

    if (state === STATES.TRANSITIONING) {
        state = STATES.ACTIVE;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortId(id) {
    return id ? id.substring(0, 8) : '--------';
}

function addLog(type, message) {
    log.push({ type, message, ts: Date.now() });
    if (log.length > 200) log = log.slice(-200);
    const line = `[Bridge/${type}] ${String(message).substring(0, 120)}`;
    console.log(line);
    try {
        const logPath = path.join(__dirname, '..', 'bridge.log');
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch { /* ignore write errors */ }
    try {
        const { broadcastAll } = require('./ws');
        broadcastAll({ type: 'bridge_status', ...getStatus() });
    } catch { /* ws not ready yet */ }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
    startBridge, stopBridge, getStatus,
    STATES,
    get state() { return state; },
    get activeCascadeId() { return session?.cascadeId || null; },
    get stepCount() { return session?.stepCount || 0; },
};
