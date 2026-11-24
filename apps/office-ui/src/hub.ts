import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  AuditReport,
  ConnectionState,
  DiscoveryReport,
  KnowledgeLintReport,
  LibraryFileResponse,
  LibraryTreeResponse,
  PendingApproval,
  PolicyBudget,
  SaveLibraryFileRequest,
  SaveLibraryFileResponse,
  SyncResult,
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

  constructor(path: string, status: number, serverError?: string) {
    super(serverError ? `${path} → HTTP ${status}: ${serverError}` : `${path} → HTTP ${status}`);
    this.name = "HubHttpError";
    this.path = path;
    this.status = status;
    this.serverError = serverError;
  }
}

async function requestJson<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HUB_HTTP}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let serverError: string | undefined;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data?.error === "string") serverError = data.error;
    } catch {
      // ignore non-JSON error body
    }
    throw new HubHttpError(path, res.status, serverError);
  }
  return (await res.json()) as T;
}

function getJson<T>(path: string): Promise<T> {
  return requestJson<T>("GET", path);
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
  return requestJson<T>("POST", path, body);
}

function putJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>("PUT", path, body);
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

const MAX_EVENTS = 200;
const DEFAULT_BUDGET: PolicyBudget = {
  alwaysOnWarnTokens: 15000,
  alwaysOnBlockTokens: 19000,
  alwaysOnHardLimitTokens: 20000,
};

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

  const refresh = useCallback(() => {
    loadApprovals();
    loadLint();
    loadAudit();
    getJson<DiscoveryReport>("/api/discovery").then(setDiscovery).catch(() => {});
    getJson<{ knowledgeBudget?: PolicyBudget }>("/api/policy")
      .then((p) => p.knowledgeBudget && setBudget({ ...DEFAULT_BUDGET, ...p.knowledgeBudget }))
      .catch(() => {});
    getJson<AgentEvent[]>("/api/events")
      .then((list) => setEvents(list.slice(0, MAX_EVENTS)))
      .catch(() => {});
  }, [loadApprovals, loadLint, loadAudit]);

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
  }, [refresh, loadApprovals, loadLint]);

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
    resolveApproval,
    createTestApproval,
    runAuditReport,
    recordSyncResult,
    stopAll,
    refresh,
  };
}
