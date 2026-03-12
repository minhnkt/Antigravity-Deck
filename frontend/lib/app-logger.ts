/**
 * Frontend App Logger
 * Captures console.error, console.warn, window.onerror, and unhandled rejections
 * and sends them to the backend via WebSocket as app_log events.
 * Import once in a root layout/provider — interception starts immediately.
 */
'use client';

import { wsService } from './ws-service';

type LogLevel = 'info' | 'warn' | 'error';

interface AppLogEntry {
    type: 'app_log';
    level: LogLevel;
    source: 'frontend';
    module: string;
    message: string;
    stack?: string;
    context?: Record<string, unknown>;
    ts: number;
}

// Throttle to avoid flooding
const _seen = new Map<string, number>();
const THROTTLE_MS = 1000;

function shouldThrottle(msg: string): boolean {
    const key = msg.slice(0, 120);
    const now = Date.now();
    const last = _seen.get(key);
    if (last && now - last < THROTTLE_MS) return true;
    _seen.set(key, now);
    if (_seen.size > 100) {
        for (const [k, v] of _seen) {
            if (now - v > 10000) _seen.delete(k);
        }
    }
    return false;
}

function send(entry: AppLogEntry) {
    if (shouldThrottle(entry.message)) return;
    wsService?.send(entry as unknown as Record<string, unknown>);
}

function formatArgs(args: unknown[]): string {
    return args.map(a => {
        if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
        if (typeof a === 'object' && a !== null) {
            try { return JSON.stringify(a); }
            catch { return String(a); }
        }
        return String(a);
    }).join(' ');
}

// === Monkey-patch console.error and console.warn ===
let _patched = false;

export function initAppLogger() {
    if (_patched || typeof window === 'undefined') return;
    _patched = true;

    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);

    console.error = function (...args: unknown[]) {
        origError(...args);
        const msg = formatArgs(args);
        const stack = (args.find(a => a instanceof Error) as Error | undefined)?.stack;
        send({
            type: 'app_log',
            level: 'error',
            source: 'frontend',
            module: extractModule(stack),
            message: msg.slice(0, 2000),
            stack: stack?.slice(0, 3000),
            ts: Date.now(),
        });
    };

    console.warn = function (...args: unknown[]) {
        origWarn(...args);
        const msg = formatArgs(args);
        send({
            type: 'app_log',
            level: 'warn',
            source: 'frontend',
            module: extractModule(),
            message: msg.slice(0, 2000),
            ts: Date.now(),
        });
    };

    // === Global error handlers ===
    window.addEventListener('error', (event) => {
        send({
            type: 'app_log',
            level: 'error',
            source: 'frontend',
            module: extractModuleFromFilename(event.filename),
            message: event.message || 'Unknown error',
            stack: `at ${event.filename}:${event.lineno}:${event.colno}`,
            context: { lineno: event.lineno, colno: event.colno, filename: event.filename },
            ts: Date.now(),
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        const msg = reason instanceof Error ? reason.message : String(reason);
        const stack = reason instanceof Error ? reason.stack : undefined;
        send({
            type: 'app_log',
            level: 'error',
            source: 'frontend',
            module: 'promise',
            message: `Unhandled Rejection: ${msg}`.slice(0, 2000),
            stack: stack?.slice(0, 3000),
            ts: Date.now(),
        });
    });
}

// Best-effort module name extraction from stack traces
function extractModule(stack?: string): string {
    if (!stack) return 'unknown';
    // Look for component/file names in stack trace lines
    const match = stack.match(/at\s+(\w[\w.]*)\s+\(/);
    if (match) return match[1];
    const fileMatch = stack.match(/\/([\w-]+)\.(tsx?|jsx?)/);
    if (fileMatch) return fileMatch[1];
    return 'unknown';
}

function extractModuleFromFilename(filename?: string | null): string {
    if (!filename) return 'unknown';
    const match = filename.match(/\/([\w-]+)\.(tsx?|jsx?)/);
    return match ? match[1] : 'unknown';
}
