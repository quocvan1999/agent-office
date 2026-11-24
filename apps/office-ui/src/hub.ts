import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  ConnectionState,
  DiscoveryReport,
  KnowledgeLintReport,
  PendingApproval,
  PolicyBudget,
} from "./types.ts";

const HOST = import.meta.env.VITE_HUB_HOST || "127.0.0.1";
const PORT = import.meta.env.VITE_HUB_PORT || "4789";
export const HUB_HTTP = `http://${HOST}:${PORT}`;
export const HUB_WS = `ws://${HOST}:${PORT}/ws`;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HUB_HTTP}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HUB_HTTP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
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
  resolveApproval: (id: string, approved: boolean) => Promise<void>;
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

  const refresh = useCallback(() => {
    loadApprovals();
    loadLint();
    getJson<DiscoveryReport>("/api/discovery").then(setDiscovery).catch(() => {});
    getJson<{ knowledgeBudget?: PolicyBudget }>("/api/policy")
      .then((p) => p.knowledgeBudget && setBudget({ ...DEFAULT_BUDGET, ...p.knowledgeBudget }))
      .catch(() => {});
    getJson<AgentEvent[]>("/api/events")
      .then((list) => setEvents(list.slice(0, MAX_EVENTS)))
      .catch(() => {});
  }, [loadApprovals, loadLint]);

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
    resolveApproval,
    stopAll,
    refresh,
  };
}
