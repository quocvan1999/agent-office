import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AccountSlot,
  AccountsResponse,
  AgentEvent,
  AgyJob,
  AgyJobCreateResponse,
  AgyJobRequest,
  AssignTaskRequest,
  AuditReport,
  BusMessage,
  ConnectionState,
  Conversation,
  ConversationDetail,
  CreateConversationRequest,
  CreateOrgAgentRequest,
  Department,
  DiscoveryReport,
  GuardrailNotice,
  HandoffTaskRequest,
  KnowledgeLintReport,
  LibraryFileResponse,
  LibraryTreeResponse,
  OrgAgent,
  OrgResponse,
  PatchOrgAgentRequest,
  PatchProviderRequest,
  PatchSlotRequest,
  PendingApproval,
  PolicyBudget,
  PostBusMessageRequest,
  ProviderRow,
  RunConversationRequest,
  RunConversationResponse,
  SaveLibraryFileRequest,
  SaveLibraryFileResponse,
  SignInSlotResponse,
  SyncResult,
  TaskRecord,
  TestApprovalResponse,
} from "./types.ts";

const HOST = import.meta.env.VITE_HUB_HOST || "127.0.0.1";
const PORT = import.meta.env.VITE_HUB_PORT || "4789";
export const HUB_HTTP = `http://${HOST}:${PORT}`;
export const HUB_WS = `ws://${HOST}:${PORT}/ws`;

export class HubHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly serverError?: string;
  readonly serverReason?: string;

  constructor(path: string, status: number, serverError?: string, serverReason?: string) {
    const detail = serverReason
      ? serverError
        ? `${serverError}: ${serverReason}`
        : serverReason
      : serverError;
    super(detail ? `${path} → HTTP ${status}: ${detail}` : `${path} → HTTP ${status}`);
    this.name = "HubHttpError";
    this.path = path;
    this.status = status;
    this.serverError = serverError;
    this.serverReason = serverReason;
  }
}

async function requestJson<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  actorId?: string
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (actorId) headers["X-Actor-Id"] = actorId;
  const res = await fetch(`${HUB_HTTP}${path}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let serverError: string | undefined;
    let serverReason: string | undefined;
    try {
      const data = (await res.json()) as { error?: unknown; reason?: unknown };
      if (typeof data?.error === "string") serverError = data.error;
      if (typeof data?.reason === "string") serverReason = data.reason;
    } catch {
      // ignore non-JSON error body
    }
    throw new HubHttpError(path, res.status, serverError, serverReason);
  }
  return (await res.json()) as T;
}

function getJson<T>(path: string, actorId?: string): Promise<T> {
  return requestJson<T>("GET", path, undefined, actorId);
}

function postJson<T>(path: string, body?: unknown, actorId?: string): Promise<T> {
  return requestJson<T>("POST", path, body, actorId);
}

function putJson<T>(path: string, body: unknown, actorId?: string): Promise<T> {
  return requestJson<T>("PUT", path, body, actorId);
}

function patchJson<T>(path: string, body: unknown, actorId?: string): Promise<T> {
  return requestJson<T>("PATCH", path, body, actorId);
}

function deleteJson<T>(path: string, actorId?: string): Promise<T> {
  return requestJson<T>("DELETE", path, undefined, actorId);
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof HubHttpError && err.status === 404;
}

export function fetchLibraryTree(): Promise<LibraryTreeResponse> {
  return getJson<LibraryTreeResponse>("/api/library/tree");
}

export function fetchLibraryFile(path: string): Promise<LibraryFileResponse> {
  return getJson<LibraryFileResponse>(`/api/library/file?path=${encodeURIComponent(path)}`);
}

export function saveLibraryFile(body: SaveLibraryFileRequest): Promise<SaveLibraryFileResponse> {
  return putJson<SaveLibraryFileResponse>("/api/library/file", body);
}

export function syncLibrary(dryRun = true): Promise<SyncResult> {
  return postJson<SyncResult>("/api/library/sync", { dryRun });
}

export async function fetchLatestAudit(): Promise<AuditReport | null> {
  const data = await getJson<AuditReport | { report: null }>("/api/audit/latest");
  if (data && "report" in data && data.report === null) return null;
  return data as AuditReport;
}

export function runAudit(ai = false): Promise<AuditReport> {
  return postJson<AuditReport>("/api/audit/run", { ai });
}

export function createDevTestApproval(action?: string): Promise<TestApprovalResponse> {
  return postJson<TestApprovalResponse>("/api/dev/test-approval", action ? { action } : {});
}

export function fetchAccounts(): Promise<AccountsResponse> {
  return getJson<AccountsResponse>("/api/accounts");
}

export function createAccountSlot(name: string): Promise<AccountSlot> {
  return postJson<AccountSlot>("/api/accounts/slots", { name });
}

export function patchAccountSlot(id: string, body: PatchSlotRequest): Promise<AccountSlot> {
  return patchJson<AccountSlot>(`/api/accounts/slots/${encodeURIComponent(id)}`, body);
}

export function deleteAccountSlot(id: string, purge = false): Promise<{ ok: boolean }> {
  const suffix = purge ? "?purge=1" : "";
  return deleteJson<{ ok: boolean }>(`/api/accounts/slots/${encodeURIComponent(id)}${suffix}`);
}

export function checkAccountSlot(id: string): Promise<AccountSlot> {
  return postJson<AccountSlot>(`/api/accounts/slots/${encodeURIComponent(id)}/check`);
}

export function signInAccountSlot(id: string, openTerminal = false): Promise<SignInSlotResponse> {
  return postJson<SignInSlotResponse>(`/api/accounts/slots/${encodeURIComponent(id)}/signin`, {
    openTerminal,
  });
}

export function patchAccountProvider(id: string, body: PatchProviderRequest): Promise<ProviderRow> {
  return patchJson<ProviderRow>(`/api/accounts/providers/${encodeURIComponent(id)}`, body);
}

export function createAgyJob(body: AgyJobRequest): Promise<AgyJobCreateResponse> {
  return postJson<AgyJobCreateResponse>("/api/agy/jobs", body);
}

export function fetchAgyJob(id: string): Promise<AgyJob> {
  return getJson<AgyJob>(`/api/agy/jobs/${encodeURIComponent(id)}`);
}

// Org, Message Bus, Conversations & Tasks
export function fetchOrg(): Promise<OrgResponse> {
  return getJson<OrgResponse>("/api/org");
}

export function createOrgAgent(body: CreateOrgAgentRequest, actorId?: string): Promise<OrgAgent> {
  return postJson<OrgAgent>("/api/org/agents", body, actorId);
}

export function patchOrgAgent(id: string, body: PatchOrgAgentRequest, actorId?: string): Promise<OrgAgent> {
  return patchJson<OrgAgent>(`/api/org/agents/${encodeURIComponent(id)}`, body, actorId);
}

export function deleteOrgAgent(id: string, actorId?: string): Promise<{ ok: boolean }> {
  return deleteJson<{ ok: boolean }>(`/api/org/agents/${encodeURIComponent(id)}`, actorId);
}

export function patchDepartmentHead(
  departmentId: string,
  headAgentId: string | null,
  actorId?: string
): Promise<Department> {
  return patchJson<Department>(
    `/api/org/departments/${encodeURIComponent(departmentId)}`,
    { headAgentId },
    actorId
  );
}

export function postBusMessage(body: PostBusMessageRequest, actorId?: string): Promise<BusMessage> {
  return postJson<BusMessage>("/api/bus/messages", body, actorId);
}

export function fetchBusMessages(params?: {
  conversationId?: string;
  limit?: number;
  includeRejected?: boolean;
}): Promise<BusMessage[]> {
  const qs = new URLSearchParams();
  if (params?.conversationId) qs.set("conversationId", params.conversationId);
  if (params?.limit != null) qs.set("limit", String(params.limit));
  if (params?.includeRejected) qs.set("includeRejected", "1");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return getJson<BusMessage[]>(`/api/bus/messages${suffix}`);
}

export function fetchConversations(status: "open" | "all" = "all"): Promise<Conversation[]> {
  return getJson<Conversation[]>(`/api/conversations?status=${encodeURIComponent(status)}`);
}

export function createConversation(body: CreateConversationRequest, actorId?: string): Promise<Conversation> {
  return postJson<Conversation>("/api/conversations", body, actorId);
}

export function fetchConversationDetail(id: string): Promise<ConversationDetail> {
  return getJson<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`);
}

export function closeConversation(id: string, summary?: string, actorId?: string): Promise<Conversation> {
  return postJson<Conversation>(
    `/api/conversations/${encodeURIComponent(id)}/close`,
    summary ? { summary } : {},
    actorId
  );
}

export function resumeConversation(id: string, actorId?: string): Promise<Conversation> {
  return postJson<Conversation>(`/api/conversations/${encodeURIComponent(id)}/resume`, {}, actorId);
}

export function runConversation(
  id: string,
  body: RunConversationRequest,
  actorId?: string
): Promise<RunConversationResponse> {
  return postJson<RunConversationResponse>(`/api/conversations/${encodeURIComponent(id)}/run`, body, actorId);
}

export function fetchTasks(): Promise<TaskRecord[]> {
  return getJson<TaskRecord[]>("/api/tasks");
}

export function assignTask(body: AssignTaskRequest, actorId?: string): Promise<TaskRecord> {
  return postJson<TaskRecord>("/api/tasks/assign", body, actorId);
}

export function handoffTask(body: HandoffTaskRequest, actorId?: string): Promise<TaskRecord> {
  return postJson<TaskRecord>("/api/tasks/handoff", body, actorId);
}

export function useClock(enabled = true, intervalMs = 1000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return nowMs;
}

const MAX_EVENTS = 200;
const MAX_BUS_MESSAGES = 250;
const DEFAULT_BUDGET: PolicyBudget = {
  alwaysOnWarnTokens: 15000,
  alwaysOnBlockTokens: 19000,
  alwaysOnHardLimitTokens: 20000,
};

function toMs(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function upsertConversation(list: Conversation[], conv: Conversation): Conversation[] {
  const next = [conv, ...list.filter((c) => c.id !== conv.id)];
  next.sort((a, b) => toMs(b.openedAt) - toMs(a.openedAt));
  return next;
}

export interface HubState {
  connection: ConnectionState;
  retryInSec: number | null;
  discovery: DiscoveryReport | null;
  lint: KnowledgeLintReport | null;
  budget: PolicyBudget;
  approvals: PendingApproval[];
  events: AgentEvent[];
  lastError: string | null;
  libraryRevision: number;
  lastLibraryChangedPath: string | null;
  auditReport: AuditReport | null;
  auditUnsupported: boolean;
  lastSyncResult: SyncResult | null;
  accounts: AccountsResponse | null;
  accountsUnsupported: boolean;
  accountsError: string | null;
  org: OrgResponse | null;
  orgUnsupported: boolean;
  orgError: string | null;
  conversations: Conversation[];
  conversationsUnsupported: boolean;
  conversationsError: string | null;
  tasks: TaskRecord[];
  tasksUnsupported: boolean;
  tasksError: string | null;
  busMessages: BusMessage[];
  busRevision: number;
  lastGuardrail: GuardrailNotice | null;
  refreshAccounts: () => Promise<void>;
  refreshOrg: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  resolveApproval: (id: string, approved: boolean) => Promise<void>;
  createTestApproval: (action?: string) => Promise<TestApprovalResponse>;
  runAuditReport: (ai?: boolean) => Promise<AuditReport>;
  recordSyncResult: (result: SyncResult) => void;
  stopAll: () => Promise<{ stoppedSessions: number; deniedApprovals: number }>;
  refresh: () => void;
}

export function useHub(): HubState {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [retryInSec, setRetryInSec] = useState<number | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryReport | null>(null);
  const [lint, setLint] = useState<KnowledgeLintReport | null>(null);
  const [budget, setBudget] = useState<PolicyBudget>(DEFAULT_BUDGET);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [lastLibraryChangedPath, setLastLibraryChangedPath] = useState<string | null>(null);
  const [auditReport, setAuditReport] = useState<AuditReport | null>(null);
  const [auditUnsupported, setAuditUnsupported] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<SyncResult | null>(null);
  const [accounts, setAccounts] = useState<AccountsResponse | null>(null);
  const [accountsUnsupported, setAccountsUnsupported] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [org, setOrg] = useState<OrgResponse | null>(null);
  const [orgUnsupported, setOrgUnsupported] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsUnsupported, setConversationsUnsupported] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [tasksUnsupported, setTasksUnsupported] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [busMessages, setBusMessages] = useState<BusMessage[]>([]);
  const [busRevision, setBusRevision] = useState(0);
  const [lastGuardrail, setLastGuardrail] = useState<GuardrailNotice | null>(null);
  const attempt = useRef(0);

  const loadApprovals = useCallback(() => {
    getJson<PendingApproval[]>("/api/approvals")
      .then(setApprovals)
      .catch((e) => setLastError(String(e)));
  }, []);

  const loadLint = useCallback(() => {
    getJson<KnowledgeLintReport>("/api/knowledge/lint")
      .then(setLint)
      .catch((e) => setLastError(String(e)));
  }, []);

  const loadAudit = useCallback(() => {
    fetchLatestAudit()
      .then((report) => {
        setAuditReport(report);
        setAuditUnsupported(false);
      })
      .catch((e) => {
        if (isNotFoundError(e)) {
          setAuditUnsupported(true);
        }
      });
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchAccounts();
      setAccounts(data);
      setAccountsUnsupported(false);
      setAccountsError(null);
    } catch (e) {
      if (isNotFoundError(e)) {
        setAccountsUnsupported(true);
        setAccountsError(null);
      } else {
        setAccountsError(e instanceof HubHttpError && e.serverError ? e.serverError : String(e));
      }
    }
  }, []);

  const loadOrg = useCallback(async () => {
    try {
      const data = await fetchOrg();
      setOrg(data);
      setOrgUnsupported(false);
      setOrgError(null);
    } catch (e) {
      if (isNotFoundError(e)) {
        setOrgUnsupported(true);
        setOrgError(null);
      } else {
        setOrgError(e instanceof HubHttpError && e.serverError ? e.serverError : String(e));
      }
    }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const list = await fetchConversations("all");
      setConversations(list);
      setConversationsUnsupported(false);
      setConversationsError(null);
    } catch (e) {
      if (isNotFoundError(e)) {
        setConversationsUnsupported(true);
        setConversationsError(null);
      } else {
        setConversationsError(e instanceof HubHttpError && e.serverError ? e.serverError : String(e));
      }
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const list = await fetchTasks();
      setTasks(list);
      setTasksUnsupported(false);
      setTasksError(null);
    } catch (e) {
      if (isNotFoundError(e)) {
        setTasksUnsupported(true);
        setTasksError(null);
      } else {
        setTasksError(e instanceof HubHttpError && e.serverError ? e.serverError : String(e));
      }
    }
  }, []);

  const refresh = useCallback(() => {
    loadApprovals();
    loadLint();
    loadAudit();
    void loadAccounts();
    void loadOrg();
    void loadConversations();
    void loadTasks();
    getJson<DiscoveryReport>("/api/discovery").then(setDiscovery).catch(() => {});
    getJson<{ knowledgeBudget?: PolicyBudget }>("/api/policy")
      .then((p) => p.knowledgeBudget && setBudget({ ...DEFAULT_BUDGET, ...p.knowledgeBudget }))
      .catch(() => {});
    getJson<AgentEvent[]>("/api/events")
      .then((list) => setEvents(list.slice(0, MAX_EVENTS)))
      .catch(() => {});
  }, [loadApprovals, loadLint, loadAudit, loadAccounts, loadOrg, loadConversations, loadTasks]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let countdown: ReturnType<typeof setInterval> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      setRetryInSec(null);
      ws = new WebSocket(HUB_WS);

      ws.onopen = () => {
        attempt.current = 0;
        setConnection("open");
        setLastError(null);
        refresh();
        pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 20000);
      };

      ws.onmessage = (msg) => {
        if (msg.data === "pong") return;
        let data: any;
        try {
          data = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        if (data.type === "hello") {
          if (data.discovery) setDiscovery(data.discovery);
          if (data.knowledgeLint) setLint(data.knowledgeLint);
          if (Array.isArray(data.pendingApprovals)) setApprovals(data.pendingApprovals);
        } else if (data.type === "agent_event" && data.event) {
          const ev = data.event as AgentEvent;
          setEvents((prev) => [ev, ...prev.filter((e) => e.id !== ev.id)].slice(0, MAX_EVENTS));
          if (ev.approvalId || ev.status === "waiting_approval" || ev.status === "stopped") {
            loadApprovals();
          }
        } else if (data.type === "library_changed") {
          setLastLibraryChangedPath(typeof data.path === "string" ? data.path : null);
          setLibraryRevision((n) => n + 1);
          loadLint();
        } else if (data.type === "audit_report" && data.report) {
          setAuditReport(data.report as AuditReport);
          setAuditUnsupported(false);
        } else if (data.type === "sync_result" && data.result) {
          setLastSyncResult(data.result as SyncResult);
          loadLint();
        } else if (data.type === "accounts_changed") {
          void loadAccounts();
        } else if (data.type === "bus_message" && data.message) {
          const m = data.message as BusMessage;
          setBusMessages((prev) => [m, ...prev.filter((x) => x.id !== m.id)].slice(0, MAX_BUS_MESSAGES));
          setBusRevision((n) => n + 1);
          if (m.conversationId) {
            setConversations((prev) =>
              prev.map((c) => (c.id === m.conversationId ? { ...c, lastMessage: m } : c))
            );
          }
        } else if (data.type === "bus_rejected" && data.message) {
          const m = data.message as BusMessage;
          setBusMessages((prev) => [m, ...prev.filter((x) => x.id !== m.id)].slice(0, MAX_BUS_MESSAGES));
          setBusRevision((n) => n + 1);
        } else if (data.type === "conversation_changed" && data.conversation) {
          const conv = data.conversation as Conversation;
          setConversations((prev) => upsertConversation(prev, conv));
          setConversationsUnsupported(false);
          setBusRevision((n) => n + 1);
        } else if (data.type === "guardrail") {
          setLastGuardrail({
            conversationId: String(data.conversationId ?? ""),
            reason: String(data.reason ?? "Guardrail kích hoạt"),
            at: Date.now(),
          });
          setBusRevision((n) => n + 1);
          void loadConversations();
        } else if (data.type === "org_changed") {
          void loadOrg();
          void loadTasks();
        }
      };

      ws.onclose = () => {
        clearInterval(pingTimer);
        if (disposed) return;
        setConnection("closed");
        // exponential backoff: 1s, 2s, 4s ... capped at 15s
        const delay = Math.min(15000, 1000 * 2 ** attempt.current);
        attempt.current += 1;
        let left = Math.ceil(delay / 1000);
        setRetryInSec(left);
        countdown = setInterval(() => {
          left -= 1;
          setRetryInSec(Math.max(0, left));
        }, 1000);
        retryTimer = setTimeout(() => {
          clearInterval(countdown);
          connect();
        }, delay);
      };

      ws.onerror = () => {
        setLastError(`Không kết nối được Hub tại ${HUB_WS}`);
      };
    };

    connect();
    const lintTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN && !document.hidden) loadLint();
    }, 60000);

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearInterval(countdown);
      clearInterval(pingTimer);
      clearInterval(lintTimer);
      ws?.close();
    };
  }, [refresh, loadApprovals, loadLint, loadAccounts, loadOrg, loadConversations, loadTasks]);

  const resolveApproval = useCallback(
    async (id: string, approved: boolean) => {
      await postJson(`/api/approvals/${encodeURIComponent(id)}`, { approved });
      loadApprovals();
    },
    [loadApprovals]
  );

  const createTestApproval = useCallback(
    async (action?: string) => {
      const res = await createDevTestApproval(action);
      loadApprovals();
      return res;
    },
    [loadApprovals]
  );

  const runAuditReport = useCallback(async (ai = false) => {
    const report = await runAudit(ai);
    setAuditReport(report);
    setAuditUnsupported(false);
    return report;
  }, []);

  const recordSyncResult = useCallback(
    (result: SyncResult) => {
      setLastSyncResult(result);
      loadLint();
    },
    [loadLint]
  );

  const stopAll = useCallback(async () => {
    const result = await postJson<{ stoppedSessions: number; deniedApprovals: number }>(
      "/api/stop-all"
    );
    loadApprovals();
    return result;
  }, [loadApprovals]);

  return {
    connection,
    retryInSec,
    discovery,
    lint,
    budget,
    approvals,
    events,
    lastError,
    libraryRevision,
    lastLibraryChangedPath,
    auditReport,
    auditUnsupported,
    lastSyncResult,
    accounts,
    accountsUnsupported,
    accountsError,
    org,
    orgUnsupported,
    orgError,
    conversations,
    conversationsUnsupported,
    conversationsError,
    tasks,
    tasksUnsupported,
    tasksError,
    busMessages,
    busRevision,
    lastGuardrail,
    refreshAccounts: loadAccounts,
    refreshOrg: loadOrg,
    refreshConversations: loadConversations,
    refreshTasks: loadTasks,
    resolveApproval,
    createTestApproval,
    runAuditReport,
    recordSyncResult,
    stopAll,
    refresh,
  };
}
