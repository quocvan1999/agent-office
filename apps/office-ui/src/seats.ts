import type {
  AgentEvent,
  ConnectionState,
  DiscoveryReport,
  KnowledgeLintReport,
  PendingApproval,
  Seat,
  SeatStatus,
} from "./types.ts";

interface SeatTemplate {
  id: string;
  name: string;
  role: string;
  kind: Seat["kind"];
  provider?: Seat["provider"];
  color: string;
}

// Fixed product roles + default desks. Discovered agents fill in readiness.
const TEMPLATES: SeatTemplate[] = [
  { id: "map", name: "Trợ lý MẬP", role: "Top Manager · điều phối", kind: "manager", color: "#ffd166" },
  { id: "token-guard", name: "Giám sát Token", role: "Hiệu suất & tiết kiệm token", kind: "supervisor", color: "#06d6a0" },
  { id: "antigravity-default", name: "Antigravity", role: "Tier 1 · UI, CRUD, test", kind: "agent", provider: "antigravity", color: "#4f9dff" },
  { id: "cursor-default", name: "Cursor", role: "Tier 3 · lõi hệ thống", kind: "agent", provider: "cursor", color: "#c77dff" },
  { id: "codex-default", name: "Codex", role: "Tier 2 · task tự trị", kind: "agent", provider: "codex", color: "#ef476f" },
  { id: "api-default", name: "API keys", role: "Tier 0 · model nhẹ (chưa cấu hình)", kind: "placeholder", provider: "api", color: "#adb5bd" },
];

const STALE_MS = 15 * 60 * 1000;

function layout(index: number): [number, number, number] {
  if (index === 0) return [0, 0, -5]; // manager desk at the head of the room
  const i = index - 1;
  const col = i % 3;
  const row = Math.floor(i / 3);
  return [(col - 1) * 4, 0, -0.8 + row * 4];
}

export function buildSeats(args: {
  discovery: DiscoveryReport | null;
  events: AgentEvent[];
  approvals: PendingApproval[];
  lint: KnowledgeLintReport | null;
  connection: ConnectionState;
}): Seat[] {
  const { discovery, events, approvals, lint, connection } = args;
  const templates = [...TEMPLATES];
  for (const a of discovery?.agents ?? []) {
    if (!templates.some((t) => t.id === a.id)) {
      templates.push({ id: a.id, name: a.displayName, role: a.provider, kind: "agent", provider: a.provider, color: "#8ecae6" });
    }
  }

  // newest event per agent (events are newest-first)
  const latest = new Map<string, AgentEvent>();
  for (const ev of events) {
    const key = templates.some((t) => t.id === ev.agentId)
      ? ev.agentId
      : templates.find((t) => t.provider === ev.provider)?.id ?? ev.agentId;
    if (!latest.has(key)) latest.set(key, ev);
  }

  const hubUp = connection === "open";
  return templates.map((t, i) => {
    const found = discovery?.agents.find((a) => a.id === t.id);
    let ready: boolean;
    let reason: string | undefined;
    if (t.kind === "manager" || t.kind === "supervisor") {
      ready = hubUp;
      reason = hubUp ? "Vai trò sản phẩm, chạy qua Hub Daemon" : "Hub Daemon chưa kết nối";
    } else if (t.kind === "placeholder") {
      ready = false;
      reason = "Chưa có API key trong vault (thêm ở Giai đoạn 3)";
    } else {
      ready = Boolean(found?.ready) && hubUp;
      reason = found?.reason ?? (discovery ? "Không phát hiện trên máy" : "Đang chờ Auto-Discovery");
    }

    const lastEvent = latest.get(t.id);
    const pending = approvals.some((a) => a.agentId === t.id && a.status === "pending");
    let status: SeatStatus = lastEvent?.status ?? (ready ? "idle" : "offline");
    // a waiting_approval event is only "live" while its approval is still pending
    if (status === "waiting_approval" && !pending) status = ready ? "idle" : "offline";
    // transient states from old history decay to idle
    if ((status === "thinking" || status === "calling_tool") && lastEvent && Date.now() - lastEvent.ts > STALE_MS) {
      status = ready ? "idle" : "offline";
    }
    if (pending) status = "waiting_approval";
    if (t.kind === "supervisor" && lint && !lastEvent) {
      const block = lint.findings.some((f) => f.severity === "block");
      const warn = lint.findings.some((f) => f.severity === "warn");
      if (block) status = "error";
      else if (warn) status = "waiting_approval";
    }
    if (!hubUp && t.kind !== "placeholder") status = "offline";

    return { ...t, ready, reason, status, lastEvent, position: layout(i) };
  });
}
