import type {
  AgentEvent,
  AgentProvider,
  AgentStatus,
  DiscoveredAgent,
} from "../../../packages/protocol/src/events.ts";

export type { AgentEvent, AgentProvider, AgentStatus, DiscoveredAgent };

export interface DiscoveryReport {
  scannedAt: string;
  host: { platform: string; arch: string; bunVersion: string };
  agents: DiscoveredAgent[];
  knowledgeHub: {
    root: string;
    exists: boolean;
    pluginVersion?: string;
    coreRuleBytes?: number;
    skillsCount: number;
    projectKits: string[];
    syncAntigravityScriptExists: boolean;
  };
}

export interface BudgetFinding {
  severity: "ok" | "warn" | "block";
  code: string;
  message: string;
  path?: string;
  value?: number;
  limit?: number;
}

export interface KnowledgeLintReport {
  checkedAt: string;
  canSync: boolean;
  alwaysOnBytes: number;
  alwaysOnEstimatedTokens: number;
  feedbackLogLines: number;
  findings: BudgetFinding[];
}

export interface PendingApproval {
  id: string;
  taskId: string;
  agentId: string;
  provider: AgentProvider;
  action: string;
  detail: string;
  createdAt: number;
  status: "pending" | "approved" | "denied";
}

export interface PolicyBudget {
  alwaysOnWarnTokens: number;
  alwaysOnBlockTokens: number;
  alwaysOnHardLimitTokens: number;
}

export type ConnectionState = "connecting" | "open" | "closed";

export type SeatStatus = AgentStatus | "offline";

export interface Seat {
  id: string;
  name: string;
  role: string;
  provider?: AgentProvider;
  kind: "manager" | "supervisor" | "agent" | "placeholder";
  ready: boolean;
  reason?: string;
  status: SeatStatus;
  lastEvent?: AgentEvent;
  position: [number, number, number];
  color: string;
}

export const STATUS_LABEL: Record<SeatStatus, string> = {
  idle: "Rảnh",
  thinking: "Đang suy nghĩ",
  calling_tool: "Đang gọi công cụ",
  waiting_approval: "Chờ duyệt!",
  completed: "Hoàn thành",
  error: "Lỗi",
  stopped: "Đã dừng",
  offline: "Chưa sẵn sàng",
};

export const STATUS_COLOR: Record<SeatStatus, string> = {
  idle: "#7c8aa5",
  thinking: "#4f9dff",
  calling_tool: "#a77bff",
  waiting_approval: "#ff8a00",
  completed: "#2ecc71",
  error: "#ff4d4f",
  stopped: "#8c8c8c",
  offline: "#3b4252",
};

// Phase 3: Knowledge Library, Sync, AI Audit
export type LibArea = "rules" | "kits" | "skills" | "agents" | "hooks" | "feedback";

export interface LibEntry {
  path: string;
  area: LibArea;
  size: number;
  tokens: number;
  mtime: string;
}

export interface LibraryTreeResponse {
  root: string;
  writable: boolean;
  entries: LibEntry[];
}

export interface LibraryFileResponse {
  path: string;
  content: string;
  tokens: number;
  mtime: string;
}

export interface SaveLibraryFileRequest {
  path: string;
  content: string;
  note: string;
  expectedMtime?: string;
}

export interface SaveLibraryFileResponse {
  ok: true;
  backupPath: string;
  pluginVersion: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface SyncResult {
  ok: boolean;
  dryRun: boolean;
  exitCode: number;
  output: string;
  skipped?: string;
}

export type AuditSeverity = "info" | "warning" | "critical";

export interface AuditFinding {
  severity: AuditSeverity;
  code: string;
  path?: string;
  message: string;
  estSavedTokens?: number;
}

export interface AuditReport {
  id: string;
  at: string;
  kind: "rule" | "ai";
  totals: {
    files: number;
    tokens: number;
    alwaysLoadedTokens: number;
  };
  findings: AuditFinding[];
  aiSummary?: string;
}

export interface TestApprovalResponse {
  approval: PendingApproval;
}
