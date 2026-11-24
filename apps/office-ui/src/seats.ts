import type {
  AgentEvent,
  AgentProvider,
  ConnectionState,
  DepartmentZone,
  DiscoveryReport,
  KnowledgeLintReport,
  OrgAgent,
  OrgAgentProvider,
  OrgResponse,
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

// Fallback fixed product roles when Hub does not expose /api/org yet.
const TEMPLATES: SeatTemplate[] = [
  { id: "map", name: "Trợ lý MẬP", role: "Top Manager · điều phối", kind: "manager", color: "#ffd166" },
  { id: "token-guard", name: "Giám sát Token", role: "Hiệu suất & tiết kiệm token", kind: "supervisor", color: "#06d6a0" },
  { id: "antigravity-default", name: "Antigravity", role: "Tier 1 · UI, CRUD, test", kind: "agent", provider: "antigravity", color: "#4f9dff" },
  { id: "cursor-default", name: "Cursor", role: "Tier 3 · lõi hệ thống", kind: "agent", provider: "cursor", color: "#c77dff" },
  { id: "codex-default", name: "Codex", role: "Tier 2 · task tự trị", kind: "agent", provider: "codex", color: "#ef476f" },
  { id: "api-default", name: "API keys", role: "Tier 0 · model nhẹ (chưa cấu hình)", kind: "placeholder", provider: "api", color: "#adb5bd" },
];

const STALE_MS = 15 * 60 * 1000;

interface ZoneSlotConfig {
  position: [number, number, number];
  color: string;
}

// Department zones arranged around the round meeting table at [0, 0, 0].
// Ban Giám đốc sits near the north control desk; Quản trị máy chủ (Cursor Hub AI) is north-east next to Library shelf.
const DEPARTMENT_LAYOUT: Record<string, ZoneSlotConfig> = {
  board: { position: [0, 0, -9.2], color: "#ffd166" },
  "server-admin": { position: [8.0, 0, -9.0], color: "#c77dff" },
  token: { position: [-8.0, 0, -9.0], color: "#06d6a0" },
  ba: { position: [-10.5, 0, -3.2], color: "#4cc9f0" },
  design: { position: [-10.5, 0, 3.0], color: "#f72585" },
  backend: { position: [10.5, 0, -3.2], color: "#4f9dff" },
  frontend: { position: [10.5, 0, 3.0], color: "#72efdd" },
  qa: { position: [-8.4, 0, 9.0], color: "#ff9f1c" },
  devops: { position: [-2.8, 0, 9.6], color: "#90be6d" },
  security: { position: [2.8, 0, 9.6], color: "#ef476f" },
  research: { position: [8.4, 0, 9.0], color: "#b5179e" },
};

const EXTRA_ZONE_COLORS = ["#8ecae6", "#ffb703", "#fb8500", "#8338ec", "#3a86ff"];

function toDiscoveryProvider(p: OrgAgentProvider): AgentProvider | undefined {
  if (p === "antigravity" || p === "cursor" || p === "codex") return p;
  return undefined;
}

function agentAvatarColor(agent: OrgAgent, zoneColor: string): string {
  if (agent.kind === "human") return "#ffd166";
  if (agent.provider === "antigravity") return "#4f9dff";
  if (agent.provider === "cursor") return "#c77dff";
  if (agent.provider === "codex") return "#ef476f";
  if (agent.kind === "grok_bot") return "#e09f3e";
  return zoneColor;
}

function layoutFallback(index: number): [number, number, number] {
  if (index === 0) return [0, 0, -6.5];
  const i = index - 1;
  const col = i % 3;
  const row = Math.floor(i / 3);
  return [(col - 1) * 4.2, 0, 4.5 + row * 3.8];
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
      templates.push({
        id: a.id,
        name: a.displayName,
        role: a.provider,
        kind: "agent",
        provider: a.provider,
        color: "#8ecae6",
      });
    }
  }

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
    if (status === "waiting_approval" && !pending) status = ready ? "idle" : "offline";
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

    return { ...t, ready, reason, status, lastEvent, position: layoutFallback(i) };
  });
}

export function buildOrgLayout(args: {
  org: OrgResponse | null;
  discovery: DiscoveryReport | null;
  events: AgentEvent[];
  approvals: PendingApproval[];
  lint: KnowledgeLintReport | null;
  connection: ConnectionState;
}): { zones: DepartmentZone[]; seats: Seat[] } {
  const { org, discovery, events, approvals, lint, connection } = args;
  if (!org || org.departments.length === 0) {
    return {
      zones: [],
      seats: buildSeats({ discovery, events, approvals, lint, connection }),
    };
  }

  const roleById = new Map(org.roles.map((r) => [r.id, r]));
  const agentById = new Map(org.agents.map((a) => [a.id, a]));
  const hubUp = connection === "open";

  // Newest event per agent id or provider
  const latestById = new Map<string, AgentEvent>();
  const latestByProvider = new Map<AgentProvider, AgentEvent>();
  for (const ev of events) {
    if (!latestById.has(ev.agentId)) latestById.set(ev.agentId, ev);
    if (!latestByProvider.has(ev.provider)) latestByProvider.set(ev.provider, ev);
  }

  const zones: DepartmentZone[] = [];
  const allSeats: Seat[] = [];
  let extraIndex = 0;

  for (const dept of org.departments) {
    const preset = DEPARTMENT_LAYOUT[dept.id];
    let zonePos: [number, number, number];
    let zoneColor: string;
    if (preset) {
      zonePos = preset.position;
      zoneColor = preset.color;
    } else {
      const angle = (extraIndex * Math.PI) / 4 + Math.PI / 8;
      zonePos = [Math.cos(angle) * 14, 0, Math.sin(angle) * 13];
      zoneColor = EXTRA_ZONE_COLORS[extraIndex % EXTRA_ZONE_COLORS.length];
      extraIndex += 1;
    }

    const members = org.agents.filter((a) => a.departmentId === dept.id);
    const cols = Math.min(3, Math.max(1, members.length));
    const rows = Math.max(1, Math.ceil(members.length / 3));
    const spacingX = 2.15;
    const spacingZ = 2.05;
    const width = Math.max(4.0, cols * spacingX + 1.4);
    const depth = Math.max(3.2, rows * spacingZ + 1.3);

    const deptSeats: Seat[] = members.map((agent, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const localX = (col - (cols - 1) / 2) * spacingX;
      const localZ = (row - (rows - 1) / 2) * spacingZ + 0.15;
      const position: [number, number, number] = [zonePos[0] + localX, 0, zonePos[2] + localZ];

      const discProvider = toDiscoveryProvider(agent.provider);
      const found = discProvider
        ? discovery?.agents.find((d) => d.id === agent.id || d.provider === discProvider)
        : undefined;
      const lastEvent =
        latestById.get(agent.id) ?? (discProvider ? latestByProvider.get(discProvider) : undefined);
      const pending = approvals.some((a) => a.agentId === agent.id && a.status === "pending");

      let ready: boolean;
      let reason: string | undefined;
      let status: SeatStatus;

      if (!hubUp) {
        ready = false;
        reason = "Hub Daemon chưa kết nối";
        status = "offline";
      } else if (agent.kind === "human") {
        ready = true;
        reason = agent.note ?? "Quản trị viên con người";
        status = agent.status === "offline" ? "offline" : "online";
      } else if (agent.kind === "grok_bot" || agent.provider === "grok_external") {
        ready = true;
        reason = agent.note ?? "Bot Grok bên ngoài — chưa có cầu nối API, trạng thái nhập tay";
        status = agent.status === "online" ? "online" : agent.status === "busy" ? "busy" : "manual";
      } else {
        // Local agent (antigravity / cursor / codex)
        const discoveredReady = found ? found.ready : agent.bridge === "hub";
        ready = Boolean(discoveredReady);
        reason =
          found?.reason ??
          agent.note ??
          (agent.bridge === "hub" ? "Kết nối qua Hub Daemon" : "Không phát hiện trên máy");
        status =
          lastEvent?.status ??
          (agent.status === "busy"
            ? "busy"
            : agent.status === "online"
              ? "online"
              : ready
                ? "idle"
                : "offline");
      }

      if (status === "waiting_approval" && !pending) status = ready ? "idle" : "offline";
      if ((status === "thinking" || status === "calling_tool") && lastEvent && Date.now() - lastEvent.ts > STALE_MS) {
        status = ready ? "idle" : "offline";
      }
      if (pending) status = "waiting_approval";

      const isSupervisor = agent.id === "giam-sat-token" || dept.id === "token";
      if (isSupervisor && lint && !lastEvent && hubUp) {
        const block = lint.findings.some((f) => f.severity === "block");
        const warn = lint.findings.some((f) => f.severity === "warn");
        if (block) status = "error";
        else if (warn) status = "waiting_approval";
      }

      const roleName = roleById.get(agent.roleId)?.name ?? agent.roleId;
      const seatKind: Seat["kind"] = isSupervisor
        ? "supervisor"
        : agent.isAdmin || dept.id === "board"
          ? "manager"
          : "agent";

      return {
        id: agent.id,
        name: agent.name,
        role: roleName,
        provider: discProvider,
        orgProvider: agent.provider,
        orgKind: agent.kind,
        departmentId: dept.id,
        departmentName: dept.name,
        isHead: agent.isHead || dept.headAgentId === agent.id,
        isAdmin: agent.isAdmin,
        bridge: agent.bridge,
        slotId: agent.slotId,
        model: agent.model,
        note: agent.note,
        kind: seatKind,
        ready,
        reason,
        status,
        lastEvent,
        position,
        color: agentAvatarColor(agent, zoneColor),
      };
    });

    const headName = dept.headAgentId ? agentById.get(dept.headAgentId)?.name ?? dept.headAgentId : null;
    zones.push({
      id: dept.id,
      name: dept.name,
      headAgentId: dept.headAgentId,
      headName,
      position: zonePos,
      size: [width, depth],
      color: zoneColor,
      seats: deptSeats,
    });
    allSeats.push(...deptSeats);
  }

  return { zones, seats: allSeats };
}
