# TODOS

## Log panel virtualization
**Status:** Deferred (post Agent Hub v1)
**What:** Replace `.map()` render in Agent Hub Logs panel with react-window or react-virtuoso for virtualized scrolling.
**Why:** With multiple concurrent agent sessions, 500 log entries re-rendering on each event may cause UI lag. Current `agent-bridge-view.tsx` uses `.map()` which works fine for single-session, but multi-session Agent Hub will have higher log volume.
**Pros:** Smooth scrolling regardless of entry count.
**Cons:** Adds dependency, increases complexity for auto-scroll logic.
**Context:** v1 ships with simple `.map()` + `React.memo` for log entries. Monitor performance after ship — virtualize if needed.
**Depends on:** Agent Hub v1 shipped and deployed.

## Backend session persistence across WS disconnects
**Status:** Deferred (v1.1)
**What:** Modify `ws-agent.js` to NOT destroy AgentSession when WebSocket closes. Instead, keep session alive with idle timeout (existing `sessionTimeoutMs` from SessionManager).
**Why:** Currently WS close = session destroyed (ws-agent.js line 157-163). External agents lose their session on network blips. The UI workaround (keeping WS open while Hub is mounted) only solves the dashboard case, not external agents (Python scripts, Claude Code, etc.).
**Pros:** External agents can reconnect and resume sessions. More resilient to network issues.
**Cons:** Must handle orphan sessions (WS closed, no reconnect within timeout). Adds complexity to session lifecycle — need session "detached" state and reconnect-by-sessionId protocol.
**Context:** Architecture review Issue 1B. User chose frontend workaround (1A) for v1. Backend persistence is the proper fix for v1.1.
**Depends on:** Agent Hub v1 ship + real-world usage patterns from external agents.
