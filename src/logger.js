// === Centralized Logger Module ===
// Intercepts console.log/warn/error and broadcasts app_log events via WebSocket.
// Also captures uncaughtException and unhandledRejection.
// Usage: require('./logger') early in server.js — interception starts immediately.

const LOG_BUFFER_MAX = 50; // buffer logs until WS is ready
const _buffer = [];
let _broadcastFn = null;

// Log levels
const LEVEL = { info: 'info', warn: 'warn', error: 'error' };

// Extract caller module name from stack trace
function getCallerModule() {
    const orig = Error.prepareStackTrace;
    Error.prepareStackTrace = (_, stack) => stack;
    const err = new Error();
    const stack = err.stack;
    Error.prepareStackTrace = orig;

    // Walk up the stack to find the first frame outside logger.js
    if (Array.isArray(stack)) {
        for (let i = 0; i < stack.length; i++) {
            const file = stack[i].getFileName();
            if (file && !file.includes('logger.js') && !file.includes('node:')) {
                const path = require('path');
                return path.basename(file, path.extname(file));
            }
        }
    }
    return 'unknown';
}

// Format args to a single string (like console does)
function formatArgs(args) {
    return args.map(a => {
        if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
        if (typeof a === 'object') {
            try { return JSON.stringify(a, null, 2); }
            catch { return String(a); }
        }
        return String(a);
    }).join(' ');
}

// Create a log entry
function createEntry(level, module, message, stack, context) {
    return {
        type: 'app_log',
        level,
        source: 'backend',
        module: module || 'unknown',
        message: typeof message === 'string' ? message.slice(0, 2000) : String(message).slice(0, 2000),
        stack: stack ? String(stack).slice(0, 3000) : undefined,
        context: context || undefined,
        ts: Date.now(),
    };
}

// Broadcast or buffer
function emit(entry) {
    if (_broadcastFn) {
        try { _broadcastFn(entry); } catch { /* can't log recursively */ }
    } else {
        _buffer.push(entry);
        if (_buffer.length > LOG_BUFFER_MAX) _buffer.shift();
    }
}

// === Monkey-patch console ===

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

// Throttle: don't broadcast noisy recurring messages
const _seen = new Map();
const THROTTLE_MS = 500;

function shouldThrottle(message) {
    const key = message.slice(0, 100);
    const now = Date.now();
    const last = _seen.get(key);
    if (last && now - last < THROTTLE_MS) return true;
    _seen.set(key, now);
    // Clean old entries periodically
    if (_seen.size > 200) {
        for (const [k, v] of _seen) {
            if (now - v > 10000) _seen.delete(k);
        }
    }
    return false;
}

// Skip internal/noisy prefixes to avoid flooding Live Logs
const SKIP_PREFIXES = ['[poll]', '[*] Poll rate', '[WS] broadcast steps_new'];

function shouldSkip(msg) {
    for (const p of SKIP_PREFIXES) {
        if (msg.startsWith(p)) return true;
    }
    return false;
}

console.log = function (...args) {
    _origLog(...args);
    const msg = formatArgs(args);
    if (!shouldSkip(msg) && !shouldThrottle(msg)) {
        emit(createEntry(LEVEL.info, getCallerModule(), msg));
    }
};

console.warn = function (...args) {
    _origWarn(...args);
    const msg = formatArgs(args);
    if (!shouldThrottle(msg)) {
        emit(createEntry(LEVEL.warn, getCallerModule(), msg));
    }
};

console.error = function (...args) {
    _origError(...args);
    const msg = formatArgs(args);
    const stack = args.find(a => a instanceof Error)?.stack;
    emit(createEntry(LEVEL.error, getCallerModule(), msg, stack));
};

// === Uncaught Errors ===

process.on('uncaughtException', (err) => {
    _origError('[UNCAUGHT]', err);
    emit(createEntry(LEVEL.error, 'process', `Uncaught Exception: ${err.message}`, err.stack, { fatal: true }));
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    _origError('[UNHANDLED_REJECTION]', reason);
    emit(createEntry(LEVEL.error, 'process', `Unhandled Rejection: ${msg}`, stack, { fatal: false }));
});

// === Public API ===

/**
 * Connect the logger to WebSocket broadcast.
 * Call after WS is set up: logger.connect(require('./ws').broadcastToGlobal);
 */
function connect(broadcastFn) {
    _broadcastFn = broadcastFn;
    // Flush buffered entries
    while (_buffer.length > 0) {
        const entry = _buffer.shift();
        try { _broadcastFn(entry); } catch { break; }
    }
}

/**
 * Manually log with full context (for use in catch blocks that want explicit module info).
 * logger.error('routes', 'Failed to create workspace', err, { path: '/api/workspaces' });
 */
function error(module, message, err, context) {
    _origError(`[${module}]`, message, err?.message || '');
    emit(createEntry(LEVEL.error, module, message + (err?.message ? `: ${err.message}` : ''), err?.stack, context));
}

function warn(module, message, context) {
    _origWarn(`[${module}]`, message);
    emit(createEntry(LEVEL.warn, module, message, undefined, context));
}

function info(module, message, context) {
    _origLog(`[${module}]`, message);
    emit(createEntry(LEVEL.info, module, message, undefined, context));
}

module.exports = { connect, error, warn, info };
