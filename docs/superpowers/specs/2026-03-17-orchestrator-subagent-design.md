# Orchestrator Sub-Agent System Design

**Date**: 2026-03-17
**Status**: Draft
**Approach**: Orchestrator Session Pattern (cascade-based)

## Overview

Extend the existing AgentSession system to support spawning multiple sub-agent cascades orchestrated by an AI planner. A dedicated `OrchestratorSession` manages the lifecycle: a planner cascade analyzes the task, decomposes it into subtasks, spawns sub-agent sessions in parallel, reviews results, and decides accept/reject for code changes.

This mirrors how Claude Code's Agent tool works: an orchestrator dispatches independent tasks to sub-agents, collects results, and synthesizes a final outcome.

## Architecture

```
User sends task
    |
OrchestratorSession receives task
    |
Planner cascade (AgentSession) analyzes -> returns structured JSON
    |
OrchestratorSession parses JSON, spawns N AgentSessions in parallel
    |
Each sub-agent runs in its own cascade, same workspace
    |
Sub-agents complete -> results sent back to planner cascade
    |
Planner reviews, decides accept/reject per subtask
    |
Final summary -> User
```

### Component Diagram

```
+---------------------+
| OrchestratorSession  |  (new, extends EventEmitter)
|   - plannerSession   |  -> AgentSession (internal, not in pool)
|   - subSessions[]    |  -> AgentSession[] (via SessionManager pool)
|   - config           |
|   - state machine    |
+---------------------+
        |
        v
+---------------------+     +------------------+
| AgentSessionManager  | <-> | AgentSession     |
| (existing, shared)   |     | (existing)       |
+---------------------+     +------------------+
        |
        v
+---------------------+
| Antigravity LS       |  (cascade backend)
+---------------------+
```

## State Machine

```
ANALYZING -> PLANNING -> AWAITING_APPROVAL -> EXECUTING -> REVIEWING -> COMPLETED
    |            |                                |            |
  FAILED       FAILED                         RECOVERING    FAILED
                                                  |
                                              EXECUTING (retry)

Any state -> CANCELLING -> CANCELLED (user cancel)
```

### State Descriptions

| State | Description |
|-------|-------------|
| ANALYZING | Planner cascade analyzing task, deciding direct vs orchestrated |
| PLANNING | Planner decomposing task into subtasks with strategy |
| AWAITING_APPROVAL | Plan ready, waiting for user to review and confirm |
| EXECUTING | Sub-agents running their assigned tasks |
| RECOVERING | Handling sub-agent failures, retrying |
| REVIEWING | Planner reviewing all sub-agent results |
| COMPLETED | All done, results available |
| FAILED | Unrecoverable failure |
| CANCELLING | User requested cancel, cleaning up |
| CANCELLED | Cancel complete |

## Task Classification

The planner cascade first classifies the task:

### Direct (no sub-agents needed)
```json
{
  "type": "direct",
  "reason": "Single file change, no decomposition needed",
  "response": "..."
}
```
OrchestratorSession acts as a simple pass-through. No sub-agents spawned. State goes ANALYZING -> COMPLETED.

### Orchestrated (sub-agents needed)
```json
{
  "type": "orchestrated",
  "subtasks": [
    {
      "id": "t1",
      "description": "Extract auth interfaces",
      "context": "Create TypeScript interfaces for auth flow",
      "affectedFiles": ["src/types/auth.ts", "src/interfaces/auth.ts"]
    },
    {
      "id": "t2",
      "description": "Create JWT middleware",
      "context": "Implement JWT verification middleware",
      "affectedFiles": ["src/middleware/jwt.ts"]
    }
  ],
  "strategy": "parallel",
  "phases": [["t1", "t2"], ["t3"]],
  "summary": "Refactoring auth into 3 tasks across 2 phases"
}
```

### Strategy Types

| Strategy | Behavior |
|----------|----------|
| parallel | All subtasks run concurrently (capped by maxParallel) |
| sequential | Run one at a time, each receives context from previous |
| phased | Grouped into phases; within phase = parallel, phases run sequentially |

### File Overlap Detection

OrchestratorSession validates `affectedFiles` across subtasks:
- If two subtasks scheduled as parallel share any files -> override to sequential
- Log warning when override happens
- Planner is instructed to minimize file overlap in decomposition

## Sub-Agent Failure Handling

### Failure Types

| Scenario | Response |
|----------|----------|
| Cascade timeout / no response | Retry with new cascade (transitionCascade). If still fails -> mark subtask failed |
| Sub-agent destroyed unexpectedly | Detect via 'destroyed' event. Spawn new session, resend task with "previous attempt failed" context |
| Planner rejects result quality | In REVIEWING phase, planner can request retry with specific feedback |

### Retry Policy
```javascript
{
  maxRetries: 2,
  retryDelayMs: 2000,
  failureThreshold: 0.5
}
```

- Each subtask retries up to `maxRetries` times
- If >50% subtasks fail (exceed retries) -> abort entire orchestration
- On abort: destroy all running sub-sessions, emit `orchestration_failed`

### Partial Completion

When some subtasks succeed and some fail (below threshold):
1. Send partial results to planner: "3/5 completed, 2 failed. Review and decide."
2. Planner returns one of:
   - `accept_partial`: accept successful results, skip failed
   - `abort_all`: reject everything
   - `retry_failed`: retry failed tasks with revised instructions

### Stuck Detection

- Poll each sub-session's `isBusy` + `lastActivity`
- If busy for longer than `stuckTimeoutMs` (default 5 min) -> destroy + retry
- Separate from cascade step limit (handled by AgentSession internally)

## Clarification Flow

When a sub-agent response appears to be a question rather than completion:

```
Sub-agent returns question
    |
OrchestratorSession sends to planner: "Sub-agent t2 asks: [question]. Can you answer?"
    |
Planner responds:
  { "canAnswer": true, "answer": "..." }  -> feed answer to sub-agent
  { "canAnswer": false }                  -> escalate to user
    |
If escalated:
  - Subtask state -> clarification
  - Other subtasks CONTINUE (not blocked)
  - Emit orch_clarification event
  - User answers via POST /clarify or WS
  - Answer sent to sub-agent -> resume
  - Timeout: 5 min -> auto-skip, mark subtask failed
```

Max clarification rounds per subtask: 2. After that, escalate is mandatory.

## LS Instance Management

- All sub-agents share the same workspace and LS instance
- Before spawning: verify LS instance is alive via `resolveLsInst()`
- If LS dies mid-orchestration:
  - Pause all sub-agents
  - Poll `resolveLsInst()` every 5s
  - Max wait: 60s
  - If LS recovers: resume with cascade transitions
  - If timeout: fail entire orchestration

## Planner Session Design

- Created directly via `new AgentSession()`, NOT through SessionManager
- Does NOT consume a pool slot
- Step limit: 2x default (plannerStepLimit: 1000)
- If planner reaches step limit -> transition cascade, resend compact state summary
- Lifecycle managed entirely by OrchestratorSession
- Destroyed when orchestration completes/fails/cancels

## Concurrency & Resource Management

### Session Pool Integration
- Sub-sessions created through `sessionManager.createSession()` (consume pool slots)
- OrchestratorSession calculates required slots before execution
- If insufficient slots -> inform user in AWAITING_APPROVAL response
- Recommendation: reduce parallelism or close idle sessions

### API Call Throttling
- `maxConcurrentApiCalls: 3` (separate from maxParallel sessions)
- Internal semaphore queues LS API calls
- Prevents overwhelming Antigravity LS

### Concurrent Orchestrations
- `maxConcurrentOrchestrations: 2` (configurable)
- Checked on `POST /start`, rejected if at limit

## Context Propagation (Phased Strategy)

Between phases:
1. Collect all sub-agent results from completed phase
2. Send to planner: "Phase N complete. Summarize for next phase."
3. Planner returns compact summary
4. Sub-agents in next phase receive: `task description + compact context`
5. Raw sub-agent output is NOT forwarded (prevents context overflow)

Sub-agent response truncated to `contextMaxChars: 5000` before sending to planner.

## Configuration

### orchestrator.settings.json
```json
{
  "enabled": true,
  "maxConcurrentOrchestrations": 2,
  "maxParallel": 5,
  "maxSubtasks": 10,
  "maxRetries": 2,
  "stuckTimeoutMs": 300000,
  "orchestrationTimeoutMs": 1800000,
  "failureThreshold": 0.5,
  "maxConcurrentApiCalls": 3,
  "plannerStepLimit": 1000,
  "historySize": 10,
  "allowMultiTurn": false,
  "maxMessagesPerSubtask": 5
}
```

### Planner Prompt

Configurable via API. Default instructs the cascade to:
1. Explore project structure first
2. Analyze the task
3. Classify as direct or orchestrated
4. If orchestrated: decompose with JSON schema, minimize file overlap, specify strategy
5. Include affectedFiles per subtask

### Sub-Agent Prompt Template

```
You are a focused sub-agent handling one part of a larger task.

## Your Assignment
[description from planner]

## Context
[context from planner]

## Previous Phase Results (if applicable)
[compact summary from planner]

## Rules
- Focus ONLY on your assigned task
- Do not modify files outside your scope
- When done, clearly state what you changed and the outcome
```

## HTTP REST API

### Endpoints

```
POST   /api/orchestrator/start                          Start orchestration (to AWAITING_APPROVAL)
POST   /api/orchestrator/:id/execute                    Confirm plan, begin execution
GET    /api/orchestrator/:id/status                     Full state for UI rebuild
POST   /api/orchestrator/:id/cancel                     Cancel orchestration
POST   /api/orchestrator/:id/clarify                    Answer clarification question
GET    /api/orchestrator/:id/events                     SSE event stream
GET    /api/orchestrator/:id/subtask/:taskId             Subtask detail
GET    /api/orchestrator/:id/subtask/:taskId/log         Subtask conversation log
GET    /api/orchestrator/list                            List orchestrations (active + history)
DELETE /api/orchestrator/:id                             Destroy orchestration
GET    /api/orchestrator/settings                        Get config
PUT    /api/orchestrator/settings                        Update config
GET    /api/orchestrator/prompt                          Get planner prompt template
PUT    /api/orchestrator/prompt                          Update planner prompt
```

### POST /start

Request:
```json
{
  "task": "Refactor auth system to use JWT",
  "workspace": "MyProject",
  "config": {
    "maxParallel": 3,
    "maxSubtasks": 8
  }
}
```

Response (after ANALYZING + PLANNING):
```json
{
  "orchestrationId": "uuid",
  "state": "AWAITING_APPROVAL",
  "plan": {
    "type": "orchestrated",
    "subtasks": [...],
    "strategy": "phased",
    "phases": [["t1","t2"], ["t3"]]
  },
  "requiredSlots": 3,
  "availableSlots": 2,
  "recommendation": "reduce_parallel_to_1"
}
```

For direct tasks, response goes straight to COMPLETED:
```json
{
  "orchestrationId": "uuid",
  "state": "COMPLETED",
  "plan": { "type": "direct", "response": "..." }
}
```

### POST /:id/execute

Request:
```json
{
  "configOverrides": {
    "maxParallel": 1
  }
}
```

Response:
```json
{
  "state": "EXECUTING",
  "message": "Execution started"
}
```

### POST /:id/clarify

Request:
```json
{
  "taskId": "t2",
  "answer": "Use RS256 for JWT signing"
}
```

### GET /:id/status

Response:
```json
{
  "id": "uuid",
  "state": "EXECUTING",
  "originalTask": "...",
  "workspace": "MyProject",
  "plan": { ... },
  "subtasks": {
    "t1": {
      "state": "completed",
      "description": "...",
      "affectedFiles": ["src/types/auth.ts"],
      "result": "truncated result...",
      "retries": 0,
      "startedAt": 1234567890,
      "completedAt": 1234567900,
      "reviewDecision": null,
      "sessionId": "uuid"
    },
    "t2": {
      "state": "running",
      "description": "...",
      "affectedFiles": ["src/middleware/jwt.ts"],
      "retries": 0,
      "startedAt": 1234567891,
      "sessionId": "uuid"
    }
  },
  "progress": 0.33,
  "elapsed": 45000,
  "currentPhase": 1,
  "totalPhases": 2,
  "recentEvents": [ ... ]
}
```

### Error Response Format
```json
{
  "error": "Orchestration not found",
  "code": "ORCHESTRATION_NOT_FOUND",
  "details": {}
}
```

Error codes: `ORCHESTRATION_NOT_FOUND`, `ALREADY_RUNNING`, `INSUFFICIENT_CAPACITY`, `INVALID_CONFIG`, `LS_UNAVAILABLE`, `MAX_ORCHESTRATIONS_REACHED`, `NOT_AWAITING_APPROVAL`

### Validation (Zod)
All request bodies validated with Zod schemas. Task string: min 1, max 10000 chars.

## WebSocket Protocol

### Endpoint
`/ws/orchestrator` (separate from existing `/ws/agent`)

### Client -> Server Messages

```javascript
{ type: 'orchestrate', task: string, workspace?: string, config?: object }
{ type: 'orchestrate_execute', orchestrationId: string, configOverrides?: object }
{ type: 'orchestrate_cancel', orchestrationId: string }
{ type: 'orchestrate_clarify', orchestrationId: string, taskId: string, answer: string }
{ type: 'orchestrate_status', orchestrationId: string }
```

### Server -> Client Messages

All messages prefixed with `orch_`:

```javascript
{ type: 'orch_started', orchestrationId, state }
{ type: 'orch_analysis', orchestrationId, planType, subtaskCount?, reason? }
{ type: 'orch_plan', orchestrationId, plan, requiredSlots, availableSlots }
{ type: 'orch_awaiting_approval', orchestrationId }
{ type: 'orch_executing', orchestrationId }
{ type: 'orch_subtask_update', orchestrationId, taskId, state, result? }
{ type: 'orch_phase_complete', orchestrationId, phase, completedTasks }
{ type: 'orch_clarification', orchestrationId, taskId, question }
{ type: 'orch_review', orchestrationId, decisions: [{taskId, action, reason}] }
{ type: 'orch_progress', orchestrationId, progress, elapsed }
{ type: 'orch_completed', orchestrationId, summary, results }
{ type: 'orch_failed', orchestrationId, reason, partialResults }
{ type: 'orch_cancelled', orchestrationId }
{ type: 'orch_log', orchestrationId, taskId?, logType, message }
{ type: 'orch_error', orchestrationId?, message }
```

## Frontend Design

### New Files
```
frontend/components/agent-hub/orchestrator-panel.tsx
frontend/components/agent-hub/orchestrator-task-card.tsx
frontend/components/agent-hub/orchestrator-timeline.tsx
frontend/hooks/use-orchestrator-ws.ts
frontend/lib/orchestrator-api.ts
```

### Modified Files
```
frontend/components/agent-hub-view.tsx       -> Add Orchestrator tab
frontend/components/agent-hub/config-panel.tsx -> Add orchestrator settings
frontend/lib/config.ts                       -> Add orchestrator types
```

### Agent Hub Tab

New "Orchestrator" tab added to the existing Agent Hub tabbed interface.

### Orchestrator Panel States

| State | UI |
|-------|------|
| Idle | Task input + workspace selector + Start button |
| ANALYZING | Spinner + "Analyzing task..." |
| PLANNING | Spinner + "Creating execution plan..." |
| AWAITING_APPROVAL | Plan display with subtask list, strategy, affected files, slot availability. [Execute] [Request Changes] [Cancel] buttons |
| EXECUTING | Subtask grid grouped by phase, progress bar, cancel button |
| AWAITING_CLARIFICATION | Same as EXECUTING but with inline clarification input on specific subtask card |
| REVIEWING | "AI reviewing results..." + subtask grid in final states |
| COMPLETED | Summary card (accepted/rejected counts, time), final subtask grid, "New Task" button |
| FAILED | Error message + partial results, retry button |
| CANCELLED | Cancellation notice + partial results, "New Task" button |

### AWAITING_APPROVAL Layout

```
+----------------------------------------------------------------+
|  Task: "Refactor auth system to use JWT"                        |
+----------------------------------------------------------------+
|  Execution Plan                     Strategy: Phased (2)        |
|                                                                 |
|  Phase 1 (parallel):                                            |
|  +----------------------------+ +----------------------------+  |
|  | t1: Extract interfaces     | | t2: Create JWT middleware  |  |
|  | Files: src/types/auth.ts   | | Files: src/middleware/jwt  |  |
|  +----------------------------+ +----------------------------+  |
|                                                                 |
|  Phase 2 (depends on Phase 1):                                  |
|  +----------------------------+                                 |
|  | t3: Migrate endpoints      |                                 |
|  | Files: src/routes/auth.ts  |                                 |
|  +----------------------------+                                 |
|                                                                 |
|  Warning: Needs 3 slots, 2 available. Will reduce parallelism.  |
|                                                                 |
|  [Execute]   [Request Changes]   [Cancel]                       |
+----------------------------------------------------------------+
```

"Request Changes" opens text input for feedback -> sent to planner -> revised plan.

### Subtask Card States

| State | Visual |
|-------|--------|
| pending | Muted/gray, dashed border |
| running | Blue border, pulse animation, elapsed timer |
| completed | Green border, checkmark, duration |
| failed | Red border, error icon, retry count |
| retrying | Orange border, refresh icon, "Retry 1/2" |
| clarification | Yellow border, question icon, inline input with countdown |

### Clarification: Inline (Not Modal)

```
+------------------------------------------+
| t2: Create JWT middleware        ? icon   |
|                                          |
| Sub-agent asks:                          |
| "Should I use RS256 or HS256?"           |
|                                          |
| [Your answer: _______________] [Send]    |
| Auto-skip in 4:32                        |
+------------------------------------------+
```

### useOrchestratorWs Hook

```typescript
interface UseOrchestratorReturn {
  orchestrationId: string | null;
  state: OrchestratorState;
  plan: OrchestratorPlan | null;
  subtasks: Map<string, SubtaskStatus>;
  progress: number;
  elapsed: number;
  error: string | null;
  logs: OrchestratorLog[];
  pendingClarification: { taskId: string; question: string } | null;

  start(task: string, workspace: string, config?: Partial<OrchestratorConfig>): void;
  execute(configOverrides?: object): void;
  cancel(): void;
  answerClarification(taskId: string, answer: string): void;
}
```

Features: auto-reconnect, state recovery via /status endpoint, event buffer replay.

### Config Panel Extension

Orchestrator Settings section in existing Config Panel:
- Enable/disable toggle
- Max parallel sub-agents (slider 1-10)
- Max subtasks per task (slider 1-20)
- Max concurrent orchestrations (slider 1-5)
- Orchestration timeout (minutes input)
- Failure threshold (% input)
- Advanced section (collapsed): retries, stuck timeout, API concurrency, planner step limit, multi-turn toggle
- Planner prompt editor (textarea with reset to default)

### Responsive Design
- Desktop: 2-3 column grid for subtask cards
- Tablet: 2 columns
- Mobile: single column stack

### History View
Dropdown showing recent orchestrations (last N based on historySize):
- Status icon + task name + subtask counts + time ago
- Click to view details or reconnect if running

### Type Definitions

```typescript
type OrchestratorState =
  | 'ANALYZING' | 'PLANNING' | 'AWAITING_APPROVAL' | 'EXECUTING'
  | 'REVIEWING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

type SubtaskState =
  | 'pending' | 'running' | 'completed' | 'failed' | 'retrying' | 'clarification';

type Strategy = 'parallel' | 'sequential' | 'phased';

interface OrchestratorPlan {
  type: 'direct' | 'orchestrated';
  subtasks?: SubtaskDefinition[];
  strategy?: Strategy;
  phases?: string[][];
  reason?: string;
  response?: string;
}

interface SubtaskDefinition {
  id: string;
  description: string;
  context: string;
  affectedFiles: string[];
}

interface SubtaskStatus {
  state: SubtaskState;
  description: string;
  affectedFiles: string[];
  result?: string;
  retries: number;
  startedAt?: number;
  completedAt?: number;
  reviewDecision?: 'accepted' | 'rejected' | null;
  clarificationQuestion?: string;
  sessionId?: string;
}

interface OrchestratorStatus {
  id: string;
  state: OrchestratorState;
  originalTask: string;
  workspace: string;
  plan: OrchestratorPlan | null;
  subtasks: Record<string, SubtaskStatus>;
  progress: number;
  elapsed: number;
  currentPhase?: number;
  totalPhases?: number;
  requiredSlots?: number;
  availableSlots?: number;
  recentEvents: OrchestratorEvent[];
}

interface OrchestratorConfig {
  enabled: boolean;
  maxConcurrentOrchestrations: number;
  maxParallel: number;
  maxSubtasks: number;
  maxRetries: number;
  stuckTimeoutMs: number;
  orchestrationTimeoutMs: number;
  failureThreshold: number;
  maxConcurrentApiCalls: number;
  plannerStepLimit: number;
  historySize: number;
  allowMultiTurn: boolean;
  maxMessagesPerSubtask: number;
}
```

## Backend File Changes

### New Files
```
src/orchestrator-session.js           Core orchestrator logic
src/ws-orchestrator.js                WebSocket /ws/orchestrator handler
src/routes/orchestrator-api.js        HTTP REST + SSE endpoints
```

### Modified Files
```
src/config.js                         Add orchestrator settings load/save
src/routes.js                         Register /api/orchestrator routes
server.js                             Add /ws/orchestrator WS server setup
src/agent-session-manager.js          Add parentOrchestrationId support
src/agent-session.js                  Add orchestrationId, role fields to getStatus()
```

### New Config File
```
orchestrator.settings.json
```

## Logging

All orchestration logs tagged with prefix:
```
[Orchestrator:abc12345] Starting analysis...
[Orchestrator:abc12345:t1] Sub-agent started
[Orchestrator:abc12345:t2] Cascade timeout, retrying (1/2)
```

Log types: system, from_agent, to_agent, error, warning

## Cleanup & History

### On Completion/Failure/Cancel
1. Destroy all sub-sessions (free pool slots)
2. Destroy planner session
3. Keep orchestration metadata in memory
4. Emit final event

### History
- In-memory, last N orchestrations (configurable `historySize: 10`)
- FIFO eviction when exceeding limit
- Auto-cleanup of old entries after 1 hour
- Accessible via `GET /api/orchestrator/list?includeCompleted=true`
- Server restart clears all history (by design, same as sessions)
