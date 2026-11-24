export type AgentKind = "human" | "grok_bot" | "local_agent";

export type AgentOrgProvider = "human" | "grok_external" | "antigravity" | "cursor" | "codex";

export type OrgEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type OrgAgentStatus = "online" | "offline" | "manual" | "idle" | "busy";

export type AgentBridge = "none" | "hub";

export interface Department {
  id: string;
  name: string;
  headAgentId: string | null;
}

export interface Role {
  id: string;
  name: string;
  departmentId: string;
  defaultProvider: AgentOrgProvider;
  defaultEffort: OrgEffort;
  systemPrompt: string;
}

export interface OrgAgent {
  id: string;
  name: string;
  departmentId: string;
  roleId: string;
  kind: AgentKind;
  provider: AgentOrgProvider;
  slotId: string | null;
  model: string | null;
  effort: OrgEffort;
  isHead: boolean;
  isAdmin: boolean;
  status: OrgAgentStatus;
  bridge: AgentBridge;
  note: string | null;
}

export type Agent = OrgAgent;

export const BUS_SUMMARY_MAX = 200;
export const BUS_BODY_MAX = 4000;
export const BUS_HANDOFF_BODY_MAX = 1500;
export const CONVERSATION_SUMMARY_MAX = 600;

export type BusMessageKind = "request" | "reply" | "handoff" | "meeting";
export type BusMessageStatus = "delivered" | "rejected";

export interface BusMessage {
  id: string;
  ts: number;
  fromAgentId: string;
  toAgentId: string | null;
  conversationId: string;
  taskId: string | null;
  kind: BusMessageKind;
  summary: string;
  body: string | null;
  tokenEstimate: number;
  status: BusMessageStatus;
  rejectReason: string | null;
}

export type ConversationType = "direct" | "meeting" | "handoff";
export type ConversationStatus = "open" | "paused" | "closed";

export interface Conversation {
  id: string;
  type: ConversationType;
  title: string;
  participants: string[];
  status: ConversationStatus;
  turnCap: number;
  turns: number;
  createdBy: string;
  taskId: string | null;
  summary: string | null;
  pauseReason: string | null;
  openedAt: number;
  closedAt: number | null;
  lastMessage?: BusMessage;
}

export type TaskKind = "assign" | "handoff";
export type TaskStatus = "assigned" | "handed_off" | "accepted" | "done";

export interface TaskRecord {
  id: string;
  title: string;
  kind: TaskKind;
  fromAgentId: string;
  departmentId: string;
  toAgentId: string | null;
  summary: string;
  decisions: string[];
  status: TaskStatus;
  conversationId: string | null;
  createdAt: number;
}
