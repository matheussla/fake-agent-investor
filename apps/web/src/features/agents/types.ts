export type { TeamAgent } from "@paper-investor/contracts";
export interface TeamPrompt { id: string; version: number; content: string; active: boolean; }
export interface TeamMessage { id: string; cursor: string; runId: string; senderName: string; recipientName: string | null; senderAgentId: string | null; recipientAgentId: string | null; content: string; createdAt: string; kind?: string; status?: string; }
export interface TeamRun { id: string; status: string; kind: string; error?: string | null; decisionId?: string | null; callCount?: number; createdAt: string; }
export interface MessagePage { messages: TeamMessage[]; nextCursor: string | null; }
