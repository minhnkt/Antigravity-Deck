// Re-export plan/subtask types from orchestrator-api
export type { OrchestratorPlan, SubtaskStatus } from './orchestrator-api';
import type { OrchestratorPlan, SubtaskStatus } from './orchestrator-api';

export type ChatMessageType =
    | 'text' | 'plan' | 'progress' | 'subtask_update'
    | 'phase_complete' | 'review' | 'completed' | 'failed'
    | 'cancelled' | 'error' | 'queued';

export type ActivityState = 'idle' | 'thinking' | 'executing' | 'reviewing' | 'queued';

export interface OrchestratorChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    messageType: ChatMessageType;
    metadata?: {
        plan?: OrchestratorPlan;
        subtasks?: Record<string, SubtaskStatus>;
        progress?: number;
        elapsed?: number;
        decisions?: Array<{ taskId: string; action: string; reason: string }>;
        error?: string;
        pendingClarification?: { taskId: string; question: string };
    };
    actions?: Array<{
        label: string;
        action: string;
        variant?: 'default' | 'destructive';
    }>;
}

export interface PendingClarification {
    taskId: string;
    question: string;
}

let _msgCounter = 0;
export function generateMessageId(): string {
    return `msg-${Date.now()}-${++_msgCounter}`;
}

export function createUserMessage(content: string): OrchestratorChatMessage {
    return {
        id: generateMessageId(),
        role: 'user',
        content,
        timestamp: Date.now(),
        messageType: 'text',
    };
}

export function createAssistantMessage(
    content: string,
    messageType: ChatMessageType = 'text',
    metadata?: OrchestratorChatMessage['metadata'],
    actions?: OrchestratorChatMessage['actions'],
): OrchestratorChatMessage {
    return {
        id: generateMessageId(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        messageType,
        metadata,
        actions,
    };
}

export function createProgressMessageId(orchRunId: string): string {
    return `progress-${orchRunId}`;
}
