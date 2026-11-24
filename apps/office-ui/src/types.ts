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

export type SeatStatus = AgentStatus | "offline" | "online" | "manual" | "busy";

export interface Seat {
  id: string;
  name: string;
  role: string;
  provider?: AgentProvider;
  orgProvider?: OrgAgentProvider;
  orgKind?: OrgAgentKind;
  departmentId?: string;
  departmentName?: string;
  isHead?: boolean;
  isAdmin?: boolean;
  bridge?: OrgAgentBridge;
  slotId?: string | null;
  model?: string | null;
  note?: string | null;
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
  online: "Trực tuyến",
  manual: "Nhập tay",
  busy: "Đang bận",
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
  online: "#2ecc71",
  manual: "#e09f3e",
  busy: "#4f9dff",
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

// Accounts & Quota
export type AccountSource = "provider" | "measured" | "manual" | "provider_snapshot";
export type ProviderSource = AccountSource | "none";

export const SOURCE_LABEL: Record<ProviderSource, string> = {
  provider: "từ nhà cung cấp",
  measured: "tự đo",
  manual: "nhập tay",
  provider_snapshot: "ảnh chụp từ nhà cung cấp",
  none: "chưa có dữ liệu",
};

export type SlotEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const SLOT_EFFORTS: SlotEffort[] = ["low", "medium", "high", "xhigh", "max"];

export type SlotStatus = "ready" | "cooldown" | "quota_low" | "signed_out" | "unknown";

export const SLOT_STATUS_LABEL: Record<SlotStatus, string> = {
  ready: "Sẵn sàng",
  quota_low: "Hạn mức thấp",
  cooldown: "Tạm nghỉ",
  signed_out: "Chưa đăng nhập",
  unknown: "Chưa rõ",
};

export const SLOT_STATUS_COLOR: Record<SlotStatus, string> = {
  ready: "#2ecc71",
  quota_low: "#f1c40f",
  cooldown: "#ff8a00",
  signed_out: "#8c8c8c",
  unknown: "#6e7681",
};

export interface QuotaWindow {
  group: string;
  window: string;
  remainingPct: number;
  resetAt: string;
  source: AccountSource;
  fetchedAt: string;
}

export interface SlotModelOption {
  id: string;
  label: string;
}

export interface SlotMeasured {
  requests: number;
  totalTokens: number;
  lastJobAt: string | null;
  source: "measured";
}

export interface SlotQuotaError {
  at: string;
  message: string;
}

export interface SlotManual {
  limitNote?: string;
  resetRule?: string;
}

export interface AccountSlot {
  id: string;
  name: string;
  homeDir: string;
  isDefault: boolean;
  enabled: boolean;
  model: string | null;
  effort: SlotEffort;
  status: SlotStatus;
  email: string | null;
  models: SlotModelOption[];
  quota: QuotaWindow[];
  credits: number | null;
  measured: SlotMeasured;
  cooldownUntil: string | null;
  lastQuotaError: SlotQuotaError | null;
  manual: SlotManual;
  lastCheckedAt: string | null;
  signInCommand: string;
}

export type ProviderKind = "cursor" | "codex" | "grok_plan" | "grok_bot";

export interface ProviderRow {
  id: string;
  label: string;
  kind: ProviderKind;
  detected?: string;
  usedPct?: number | null;
  sharePct?: number | null;
  resetAt?: string | null;
  resetRule?: string | null;
  limitNote?: string | null;
  note?: string | null;
  source: ProviderSource;
  updatedAt: string | null;
}

export interface AccountsResponse {
  slots: AccountSlot[];
  providers: ProviderRow[];
  quotaLowPct: number;
}

export interface PatchSlotRequest {
  name?: string;
  model?: string | null;
  effort?: SlotEffort;
  enabled?: boolean;
  manual?: SlotManual;
}

export interface SignInSlotResponse {
  command: string;
  opened: boolean;
}

export interface PatchProviderRequest {
  usedPct?: number | null;
  sharePct?: number | null;
  resetAt?: string | null;
  resetRule?: string | null;
  limitNote?: string | null;
  note?: string | null;
  source?: "manual" | "provider_snapshot";
}

export interface AgyJobRequest {
  prompt: string;
  cwd: string;
  slotId?: string;
  model?: string;
  effort?: SlotEffort;
  autoEdit?: boolean;
}

export interface AgyJobCreateResponse {
  jobId: string;
  slotId: string;
}

export interface AgyJob {
  id: string;
  status: "queued" | "running" | "done" | "error" | "waiting_approval";
  slotId: string;
  attempts: Array<{ slotId: string; outcome: string }>;
  usage?: Record<string, number>;
  error?: unknown;
}

// Org, Message Bus, Meeting Room & Tasks (docs/specs/org-contract.md)
export interface Department {
  id: string;
  name: string;
  headAgentId: string | null;
}

export interface OrgRole {
  id: string;
  name: string;
  departmentId: string;
  defaultProvider?: string | null;
  defaultEffort?: SlotEffort | string | null;
  systemPrompt?: string | null;
}

export type OrgAgentKind = "human" | "grok_bot" | "local_agent";
export type OrgAgentProvider = "human" | "grok_external" | "antigravity" | "cursor" | "codex";
export type OrgAgentStatus = "online" | "offline" | "manual" | "idle" | "busy";
export type OrgAgentBridge = "none" | "hub";

export interface OrgAgent {
  id: string;
  name: string;
  departmentId: string;
  roleId: string;
  kind: OrgAgentKind;
  provider: OrgAgentProvider;
  slotId: string | null;
  model: string | null;
  effort?: SlotEffort | string | null;
  isHead: boolean;
  isAdmin: boolean;
  status: OrgAgentStatus;
  bridge: OrgAgentBridge;
  note?: string | null;
}

export interface OrgResponse {
  departments: Department[];
  roles: OrgRole[];
  agents: OrgAgent[];
}

export interface CreateOrgAgentRequest {
  id?: string;
  name: string;
  departmentId: string;
  roleId: string;
  kind?: OrgAgentKind;
  provider: OrgAgentProvider;
  slotId?: string | null;
  model?: string | null;
  effort?: SlotEffort | string | null;
  bridge?: OrgAgentBridge;
  note?: string | null;
}

export interface PatchOrgAgentRequest {
  name?: string;
  departmentId?: string;
  roleId?: string;
  provider?: OrgAgentProvider;
  slotId?: string | null;
  model?: string | null;
  effort?: SlotEffort | string | null;
  status?: OrgAgentStatus;
  bridge?: OrgAgentBridge;
  note?: string | null;
}

export type BusMessageKind = "request" | "reply" | "handoff" | "meeting";
export type BusMessageStatus = "delivered" | "rejected";

export interface BusMessage {
  id: string;
  ts: number | string;
  fromAgentId: string;
  toAgentId: string | null;
  conversationId: string | null;
  taskId: string | null;
  kind: BusMessageKind;
  summary: string;
  body: string | null;
  tokenEstimate: number;
  status: BusMessageStatus;
  rejectReason: string | null;
}

export interface PostBusMessageRequest {
  fromAgentId: string;
  toAgentId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  kind: BusMessageKind;
  summary: string;
  body?: string | null;
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
  openedAt: number | string;
  closedAt: number | string | null;
  lastMessage?: BusMessage | null;
}

export interface ConversationDetail extends Conversation {
  messages: BusMessage[];
}

export interface CreateConversationRequest {
  type: "meeting";
  title: string;
  participants: string[];
  turnCap?: number;
  taskId?: string | null;
}

export interface RunConversationRequest {
  rounds: number;
  prompt: string;
}

export interface RunConversationResponse {
  ok: boolean;
  runId: string;
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
  createdAt: number | string;
}

export interface AssignTaskRequest {
  title: string;
  departmentId: string;
  toAgentId?: string | null;
  summary: string;
  decisions?: string[];
}

export interface HandoffTaskRequest {
  title: string;
  fromAgentId: string;
  departmentId: string;
  toAgentId?: string | null;
  summary: string;
  decisions?: string[];
}

export interface GuardrailNotice {
  conversationId: string;
  reason: string;
  at: number;
}

export interface DepartmentZone {
  id: string;
  name: string;
  headAgentId: string | null;
  headName: string | null;
  position: [number, number, number];
  size: [number, number];
  color: string;
  seats: Seat[];
}

export const CONVERSATION_TYPE_LABEL: Record<ConversationType, string> = {
  direct: "Trực tiếp",
  meeting: "Cuộc họp",
  handoff: "Bàn giao",
};

export const CONVERSATION_STATUS_LABEL: Record<ConversationStatus, string> = {
  open: "Đang mở",
  paused: "Tạm dừng",
  closed: "Đã đóng",
};

export const BUS_KIND_LABEL: Record<BusMessageKind, string> = {
  request: "Yêu cầu",
  reply: "Phản hồi",
  handoff: "Bàn giao",
  meeting: "Họp",
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  assigned: "Đã giao",
  handed_off: "Đã bàn giao",
  accepted: "Đã nhận",
  done: "Hoàn tất",
};

export const GROK_BOT_BADGE = "Bot Grok ngoài · nhập tay";
