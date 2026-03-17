'use client';

import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Copy, Check, Globe, Cable, Wifi, Key, RefreshCw, ChevronDown,
    Terminal, Code2, Unplug, BookOpen,
} from 'lucide-react';
import { API_BASE } from '@/lib/config';
import { authHeaders } from '@/lib/auth';
import { MarkdownRenderer } from '@/components/markdown-renderer';

// ── Types ───────────────────────────────────────────────────────────────

interface TunnelInfo {
    active: boolean;
    frontend?: string;
    backend?: string;
    authKey?: string;
    wsAgent?: string;
    qrUrl?: string;
    localFe?: string;
    localBe?: string;
    started?: string;
}

// ── Copy Button ─────────────────────────────────────────────────────────

function CopyBtn({ text, className }: { text: string; className?: string }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [text]);
    return (
        <button
            onClick={handleCopy}
            className={cn('p-1 rounded hover:bg-muted/20 text-muted-foreground/40 hover:text-muted-foreground/70 transition-all', className)}
            title="Copy"
        >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        </button>
    );
}

// ── URL Row ─────────────────────────────────────────────────────────────

function UrlRow({ icon: Icon, label, value }: { icon: typeof Globe; label: string; value: string }) {
    return (
        <div className="flex items-center gap-2 py-1">
            <Icon className="h-3 w-3 text-muted-foreground/40 shrink-0" />
            <span className="text-[10px] text-muted-foreground/60 w-16 shrink-0">{label}</span>
            <code className="text-[10px] font-mono text-foreground/70 truncate flex-1 min-w-0">{value}</code>
            <CopyBtn text={value} />
        </div>
    );
}

// ── Snippet Tabs ────────────────────────────────────────────────────────

const SNIPPET_TABS = ['curl', 'Python', 'wscat', 'Claude Code'] as const;
type SnippetTab = typeof SNIPPET_TABS[number];

function buildSnippets(baseUrl: string, wsUrl: string, authKey: string): Record<SnippetTab, string> {
    const authHeader = authKey ? `\n  -H "X-Auth-Key: ${authKey}" \\` : '';
    const authWsParam = authKey ? `?auth_key=${authKey}` : '';

    return {
        'curl': `\`\`\`bash
# 1. Connect — create a new session
curl -X POST ${baseUrl}/api/agent/connect \\
  -H "Content-Type: application/json" \\${authHeader}
  -d '{"workspace":"MyProject"}'

# Response: {"sessionId":"abc-123","cascadeId":"...","workspace":"MyProject"}

# 2. Send message
curl -X POST ${baseUrl}/api/agent/abc-123/send \\
  -H "Content-Type: application/json" \\${authHeader}
  -d '{"message":"Fix the login bug"}'

# 3. List sessions
curl ${baseUrl}/api/agent/sessions${authKey ? ` \\\n  -H "X-Auth-Key: ${authKey}"` : ''}

# 4. Destroy session
curl -X DELETE ${baseUrl}/api/agent/abc-123${authKey ? ` \\\n  -H "X-Auth-Key: ${authKey}"` : ''}
\`\`\``,

        'Python': `\`\`\`python
import requests

BASE = "${baseUrl}"
HEADERS = {
    "Content-Type": "application/json",${authKey ? `\n    "X-Auth-Key": "${authKey}",` : ''}
}

# 1. Connect
r = requests.post(f"{BASE}/api/agent/connect",
    json={"workspace": "MyProject"}, headers=HEADERS)
session = r.json()
sid = session["sessionId"]
print(f"Connected: {sid}")

# 2. Send message (blocking — waits for response)
r = requests.post(f"{BASE}/api/agent/{sid}/send",
    json={"message": "Fix the login bug"}, headers=HEADERS)
print(r.json()["text"])

# 3. Accept/reject code changes
requests.post(f"{BASE}/api/agent/{sid}/accept", headers=HEADERS)

# 4. Disconnect
requests.delete(f"{BASE}/api/agent/{sid}", headers=HEADERS)
\`\`\``,

        'wscat': `\`\`\`bash
# Install: npm i -g wscat
wscat -c "${wsUrl}${authWsParam}"

# → Connect to workspace
> {"type":"connect","workspace":"MyProject"}
# ← {"type":"connected","sessionId":"...","cascadeId":"..."}

# → Send message
> {"type":"send","message":"Fix the login bug"}
# ← {"type":"busy","isBusy":true}
# ← {"type":"response","text":"...","stepIndex":3,"stepCount":4}

# → Accept/reject code changes
> {"type":"accept"}
> {"type":"reject"}

# → New cascade (reset conversation)
> {"type":"switch_workspace","workspace":"MyProject"}

# → Disconnect
> {"type":"disconnect"}
\`\`\``,

        'Claude Code': `\`\`\`markdown
# In Claude Code, use MCP or curl tool:

Antigravity Deck Agent API:
- Base URL: ${baseUrl}
- Agent WS: ${wsUrl}${authKey ? `\n- Auth Key: ${authKey}` : ''}

## Connect & send
POST ${baseUrl}/api/agent/connect
  Body: {"workspace":"MyProject"}

POST ${baseUrl}/api/agent/{sessionId}/send
  Body: {"message":"your instruction here"}

## Real-time (WebSocket)
Connect to: ${wsUrl}${authWsParam}
Send: {"type":"connect","workspace":"MyProject"}
Send: {"type":"send","message":"your instruction"}
\`\`\``,
    };
}

// ── API Reference ───────────────────────────────────────────────────────

function buildApiRef(baseUrl: string, wsUrl: string): string {
    return `
### HTTP Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| \`POST\` | \`/api/agent/connect\` | Create new session. Body: \`{"workspace","cascadeId?","stepSoftLimit?"}\` |
| \`POST\` | \`/api/agent/:id/send\` | Send message (blocking). Body: \`{"message","action?","authorName?"}\` |
| \`GET\` | \`/api/agent/:id/status\` | Get session status |
| \`POST\` | \`/api/agent/:id/accept\` | Accept code changes |
| \`POST\` | \`/api/agent/:id/reject\` | Reject code changes |
| \`POST\` | \`/api/agent/:id/switch-workspace\` | Switch workspace |
| \`DELETE\` | \`/api/agent/:id\` | Destroy session |
| \`GET\` | \`/api/agent/sessions\` | List all active sessions |
| \`GET\` | \`/api/agent-api/settings\` | Get API settings |
| \`PUT\` | \`/api/agent-api/settings\` | Update API settings |

### WebSocket Protocol

**Endpoint:** \`${wsUrl}\`

**Client → Server:**

| Type | Fields | Description |
|------|--------|-------------|
| \`connect\` | \`workspace, cascadeId?, transport?\` | Open session |
| \`send\` | \`message, action?, authorName?\` | Send message |
| \`accept\` | — | Accept code changes |
| \`reject\` | — | Reject code changes |
| \`switch_workspace\` | \`workspace\` | Switch workspace / create new cascade |
| \`status\` | — | Query session status |
| \`disconnect\` | — | Close session |

**Server → Client:**

| Type | Fields | Description |
|------|--------|-------------|
| \`connected\` | \`sessionId, cascadeId, workspace\` | Session opened |
| \`response\` | \`text, stepIndex, stepCount, stepType\` | Agent response |
| \`busy\` | \`isBusy\` | Processing state change |
| \`cascade_transition\` | \`oldId, newId, reason\` | Cascade switched |
| \`step_limit_warning\` | \`stepCount, softLimit\` | Approaching limit |
| \`error\` | \`message\` | Error occurred |
| \`disconnected\` | — | Session closed |
`;
}

// ── Main Panel ──────────────────────────────────────────────────────────

export function AgentConnectPanel() {
    const [tunnel, setTunnel] = useState<TunnelInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [activeSnippet, setActiveSnippet] = useState<SnippetTab>('curl');
    const [showApiRef, setShowApiRef] = useState(false);

    // Fetch tunnel info
    const fetchTunnel = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/tunnel-info`, { headers: authHeaders() });
            if (res.ok) setTunnel(await res.json());
            else setTunnel({ active: false });
        } catch {
            setTunnel({ active: false });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchTunnel(); }, [fetchTunnel]);

    // Derive URLs
    const backendUrl = tunnel?.active && tunnel.backend ? tunnel.backend : `http://localhost:3500`;
    const wsAgentUrl = tunnel?.active && tunnel.wsAgent ? tunnel.wsAgent
        : `ws://localhost:3500/ws/agent`;
    const authKey = tunnel?.authKey || '';

    // Build dynamic snippets
    const snippets = buildSnippets(backendUrl, wsAgentUrl, authKey);
    const apiRef = buildApiRef(backendUrl, wsAgentUrl);

    // Tunnel age
    let tunnelAge = '';
    if (tunnel?.started) {
        const elapsed = Date.now() - new Date(tunnel.started).getTime();
        if (elapsed < 3600000) tunnelAge = `${Math.floor(elapsed / 60000)}m ago`;
        else tunnelAge = `${Math.floor(elapsed / 3600000)}h ago`;
    }

    return (
        <ScrollArea className="h-full">
            <div className="p-3 space-y-3">

                {/* ── Connection Info ─────────────────────────────── */}
                <Card className="bg-muted/5 border-border/20">
                    <CardContent className="p-3 space-y-1">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-1.5">
                                <Cable className="h-3.5 w-3.5 text-muted-foreground/60" />
                                <span className="text-xs font-medium text-foreground/80">Connection</span>
                            </div>
                            <div className="flex items-center gap-2">
                                {tunnel?.active ? (
                                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-emerald-400 bg-emerald-400/10 border-emerald-400/20">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1" />
                                        Tunnel active{tunnelAge ? ` · ${tunnelAge}` : ''}
                                    </Badge>
                                ) : (
                                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground/50 bg-muted/10">
                                        Local only
                                    </Badge>
                                )}
                                <button onClick={fetchTunnel} className="p-0.5 rounded hover:bg-muted/20 text-muted-foreground/40 hover:text-muted-foreground/70">
                                    <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
                                </button>
                            </div>
                        </div>

                        <UrlRow icon={Globe} label="Backend" value={backendUrl} />
                        <UrlRow icon={Wifi} label="Agent WS" value={wsAgentUrl} />
                        {authKey && <UrlRow icon={Key} label="Auth Key" value={authKey} />}
                        {tunnel?.active && tunnel.frontend && (
                            <UrlRow icon={Globe} label="Frontend" value={tunnel.frontend} />
                        )}
                        {tunnel?.active && tunnel.qrUrl && (
                            <UrlRow icon={Globe} label="QR URL" value={tunnel.qrUrl} />
                        )}
                    </CardContent>
                </Card>

                {/* ── Quick Connect ───────────────────────────────── */}
                <Card className="bg-muted/5 border-border/20">
                    <CardContent className="p-3 space-y-2">
                        <div className="flex items-center gap-1.5 mb-1">
                            <Terminal className="h-3.5 w-3.5 text-muted-foreground/60" />
                            <span className="text-xs font-medium text-foreground/80">Quick Connect</span>
                        </div>

                        {/* Segment buttons */}
                        <div className="flex gap-1">
                            {SNIPPET_TABS.map(tab => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveSnippet(tab)}
                                    className={cn(
                                        'text-[10px] px-2 py-1 rounded transition-all',
                                        activeSnippet === tab
                                            ? 'bg-muted/20 text-foreground/80 font-medium'
                                            : 'text-muted-foreground/50 hover:text-muted-foreground/70 hover:bg-muted/10'
                                    )}
                                >
                                    {tab}
                                </button>
                            ))}
                        </div>

                        {/* Snippet content */}
                        <div className="relative">
                            <MarkdownRenderer content={snippets[activeSnippet]} className="text-[11px]" />
                        </div>
                    </CardContent>
                </Card>

                {/* ── API Reference (collapsible) ────────────────── */}
                <Card className="bg-muted/5 border-border/20">
                    <CardContent className="p-0">
                        <button
                            onClick={() => setShowApiRef(!showApiRef)}
                            className="flex items-center gap-1.5 w-full p-3 text-left hover:bg-muted/5 transition-colors"
                        >
                            <BookOpen className="h-3.5 w-3.5 text-muted-foreground/60" />
                            <span className="text-xs font-medium text-foreground/80 flex-1">API Reference</span>
                            <ChevronDown className={cn('h-3 w-3 text-muted-foreground/40 transition-transform', showApiRef && 'rotate-180')} />
                        </button>
                        {showApiRef && (
                            <div className="px-3 pb-3 border-t border-border/10">
                                <MarkdownRenderer content={apiRef} className="text-[11px]" />
                            </div>
                        )}
                    </CardContent>
                </Card>

            </div>
        </ScrollArea>
    );
}
