import type {
  AgentBridge,
  AgentKind,
  AgentOrgProvider,
  Department,
  OrgAgent,
  OrgAgentStatus,
  OrgEffort,
  Role,
} from "../../../packages/protocol/src/org.ts";
import type {
  OfficeDatabase,
  OrgAgentDbRow,
  OrgDepartmentDbRow,
  OrgRoleDbRow,
} from "./db.ts";

export class OrgError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reason?: string
  ) {
    super(message);
    this.name = "OrgError";
  }
}

export interface OrgServiceOptions {
  db: OfficeDatabase;
  onOrgChanged?: () => void;
}

const VALID_KINDS = new Set<AgentKind>(["human", "grok_bot", "local_agent"]);
const VALID_PROVIDERS = new Set<AgentOrgProvider>([
  "human",
  "grok_external",
  "antigravity",
  "cursor",
  "codex",
]);
const VALID_EFFORTS = new Set<OrgEffort>(["low", "medium", "high", "xhigh", "max"]);
const VALID_STATUSES = new Set<OrgAgentStatus>(["online", "offline", "manual", "idle", "busy"]);
const VALID_BRIDGES = new Set<AgentBridge>(["none", "hub"]);

const GROK_BOT_NOTE =
  "Bot Grok Bot bên ngoài — chưa có cầu nối API, trạng thái nhập tay";

const SEED_DEPARTMENTS: OrgDepartmentDbRow[] = [
  { id: "board", name: "Ban Giám đốc", head_agent_id: "ly-van" },
  { id: "server-admin", name: "Quản trị máy chủ", head_agent_id: "cursor-hub-ai" },
  { id: "ba", name: "BA / Phân tích", head_agent_id: "chuyen-gia-ba" },
  { id: "design", name: "Thiết kế", head_agent_id: null },
  { id: "backend", name: "Backend", head_agent_id: "tho-code" },
  { id: "frontend", name: "Frontend / Mobile", head_agent_id: null },
  { id: "qa", name: "QA / Kiểm thử", head_agent_id: null },
  { id: "devops", name: "DevOps", head_agent_id: null },
  { id: "security", name: "An ninh", head_agent_id: "hacker-lo" },
  { id: "research", name: "Nghiên cứu", head_agent_id: "tcs-ai-lab" },
  { id: "token", name: "Giám sát Token", head_agent_id: "giam-sat-token" },
];

const SEED_ROLES: OrgRoleDbRow[] = [
  {
    id: "board-admin",
    name: "Ban Giám đốc",
    department_id: "board",
    default_provider: "human",
    default_effort: "medium",
    system_prompt:
      "Bạn thuộc Ban Giám đốc, điều phối chiến lược và phê duyệt quyết định quan trọng.",
  },
  {
    id: "server-admin",
    name: "Quản trị máy chủ",
    department_id: "server-admin",
    default_provider: "grok_external",
    default_effort: "medium",
    system_prompt:
      "Bạn là quản trị máy chủ, phụ trách hạ tầng, cấu hình hub và tính ổn định hệ thống.",
  },
  {
    id: "ba-analyst",
    name: "Chuyên gia BA",
    department_id: "ba",
    default_provider: "antigravity",
    default_effort: "low",
    system_prompt:
      "Bạn là chuyên gia phân tích nghiệp vụ (BA), làm rõ yêu cầu, phạm vi và tiêu chí nghiệm thu ngắn gọn.",
  },
  {
    id: "designer",
    name: "Thiết kế UI/UX",
    department_id: "design",
    default_provider: "antigravity",
    default_effort: "low",
    system_prompt:
      "Bạn là chuyên gia thiết kế giao diện và trải nghiệm người dùng, tập trung vào bố cục rõ ràng và nhất quán.",
  },
  {
    id: "backend-dev",
    name: "Kỹ sư Backend",
    department_id: "backend",
    default_provider: "antigravity",
    default_effort: "low",
    system_prompt:
      "Bạn là kỹ sư Backend, thiết kế API, dữ liệu, bảo mật và hiệu năng dịch vụ.",
  },
  {
    id: "frontend-dev",
    name: "Kỹ sư Frontend / Mobile",
    department_id: "frontend",
    default_provider: "antigravity",
    default_effort: "low",
    system_prompt:
      "Bạn là kỹ sư Frontend/Mobile, xây dựng giao diện phản hồi nhanh và đồng bộ với hợp đồng API.",
  },
  {
    id: "qa-tester",
    name: "Kỹ sư QA / Kiểm thử",
    department_id: "qa",
    default_provider: "antigravity",
    default_effort: "low",
    system_prompt:
      "Bạn là kỹ sư QA, xác định ca kiểm thử, phát hiện rủi ro và kiểm tra chất lượng đầu ra.",
  },
  {
    id: "devops-engineer",
    name: "Kỹ sư DevOps",
    department_id: "devops",
    default_provider: "antigravity",
    default_effort: "low",
    system_prompt:
      "Bạn là kỹ sư DevOps, phụ trách CI/CD, triển khai, giám sát và tự động hóa vận hành.",
  },
  {
    id: "security-reviewer",
    name: "Chuyên gia An ninh",
    department_id: "security",
    default_provider: "grok_external",
    default_effort: "medium",
    system_prompt:
      "Bạn là chuyên gia an ninh, rà soát lỗ hổng, phân quyền và bảo vệ dữ liệu nhạy cảm.",
  },
  {
    id: "researcher",
    name: "Chuyên gia Nghiên cứu",
    department_id: "research",
    default_provider: "grok_external",
    default_effort: "medium",
    system_prompt:
      "Bạn là chuyên gia nghiên cứu, đánh giá công nghệ, mô hình AI và đề xuất phương án tối ưu.",
  },
  {
    id: "token-supervisor",
    name: "Giám sát Token",
    department_id: "token",
    default_provider: "grok_external",
    default_effort: "low",
    system_prompt:
      "Bạn là giám sát Token, theo dõi hạn mức, chi phí và cảnh báo lãng phí ngữ cảnh.",
  },
];

const SEED_AGENTS: OrgAgentDbRow[] = [
  {
    id: "ly-van",
    name: "Lý Văn",
    department_id: "board",
    role_id: "board-admin",
    kind: "human",
    provider: "human",
    slot_id: null,
    model: null,
    effort: "medium",
    is_admin: 1,
    status: "online",
    bridge: "none",
    note: null,
  },
  {
    id: "tro-ly-map",
    name: "Trợ lý MẬP",
    department_id: "board",
    role_id: "board-admin",
    kind: "grok_bot",
    provider: "grok_external",
    slot_id: null,
    model: null,
    effort: "medium",
    is_admin: 1,
    status: "manual",
    bridge: "none",
    note: GROK_BOT_NOTE,
  },
  {
    id: "cursor-hub-ai",
    name: "Cursor Hub AI",
    department_id: "server-admin",
    role_id: "server-admin",
    kind: "grok_bot",
    provider: "grok_external",
    slot_id: null,
    model: null,
    effort: "medium",
    is_admin: 0,
    status: "manual",
    bridge: "none",
    note: GROK_BOT_NOTE,
  },
  {
    id: "chuyen-gia-ba",
    name: "Chuyên gia BA",
    department_id: "ba",
    role_id: "ba-analyst",
    kind: "grok_bot",
    provider: "grok_external",
    slot_id: null,
    model: null,
    effort: "low",
    is_admin: 0,
    status: "manual",
    bridge: "none",
    note: GROK_BOT_NOTE,
  },
  {
    id: "tho-code",
    name: "Thợ Code",
    department_id: "backend",
    role_id: "backend-dev",
    kind: "grok_bot",
    provider: "grok_external",
    slot_id: null,
    model: null,
    effort: "low",
    is_admin: 0,
    status: "manual",
    bridge: "none",
    note: GROK_BOT_NOTE,
  },
  {
    id: "hacker-lo",
    name: "Hacker Lõ",
    department_id: "security",
    role_id: "security-reviewer",
    kind: "grok_bot",
    provider: "grok_external",
    slot_id: null,
    model: null,
    effort: "medium",
    is_admin: 0,
    status: "manual",
    bridge: "none",
    note: GROK_BOT_NOTE,
  },
  {
    id: "tcs-ai-lab",
    name: "TCS AI Lab",
    department_id: "research",
    role_id: "researcher",
    kind: "grok_bot",
    provider: "grok_external",
    slot_id: null,
    model: null,
    effort: "medium",
    is_admin: 0,
    status: "manual",
    bridge: "none",
    note: GROK_BOT_NOTE,
  },
  {
    id: "giam-sat-token",
    name: "Giám sát Token",
    department_id: "token",
    role_id: "token-supervisor",
    kind: "grok_bot",
    provider: "grok_external",
    slot_id: null,
    model: null,
    effort: "low",
    is_admin: 0,
    status: "manual",
    bridge: "none",
    note: GROK_BOT_NOTE,
  },
  {
    id: "ba-agy-1",
    name: "BA-1 (agy)",
    department_id: "ba",
    role_id: "ba-analyst",
    kind: "local_agent",
    provider: "antigravity",
    slot_id: "default",
    model: null,
    effort: "low",
    is_admin: 0,
    status: "idle",
    bridge: "hub",
    note: null,
  },
  {
    id: "be-agy-1",
    name: "BE-1 (agy)",
    department_id: "backend",
    role_id: "backend-dev",
    kind: "local_agent",
    provider: "antigravity",
    slot_id: "default",
    model: null,
    effort: "low",
    is_admin: 0,
    status: "idle",
    bridge: "hub",
    note: null,
  },
];

const PROTECTED_SEED_IDS = new Set(["ly-van", "tro-ly-map"]);

function slugifyId(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "agent";
}

export function resolveActorId(headerValue: string | null | undefined): string {
  const trimmed = typeof headerValue === "string" ? headerValue.trim() : "";
  return trimmed || "ly-van";
}

export class OrgService {
  private readonly db: OfficeDatabase;
  private readonly onOrgChanged?: () => void;

  constructor(opts: OrgServiceOptions) {
    this.db = opts.db;
    this.onOrgChanged = opts.onOrgChanged;
    this.seedOnce();
  }

  private seedOnce(): void {
    if (this.db.getOrgMeta("seeded_v1") === "1") return;
    for (const dept of SEED_DEPARTMENTS) {
      this.db.insertOrgDepartmentIfNotExists(dept);
    }
    for (const role of SEED_ROLES) {
      this.db.insertOrgRoleIfNotExists(role);
    }
    for (const agent of SEED_AGENTS) {
      this.db.insertOrgAgentIfNotExists(agent);
    }
    this.db.setOrgMeta("seeded_v1", "1");
  }

  private emitOrgChanged(): void {
    try {
      this.onOrgChanged?.();
    } catch {
      // isolate callback errors
    }
  }

  private hydrateDepartment(row: OrgDepartmentDbRow): Department {
    return {
      id: row.id,
      name: row.name,
      headAgentId: row.head_agent_id,
    };
  }

  private hydrateRole(row: OrgRoleDbRow): Role {
    return {
      id: row.id,
      name: row.name,
      departmentId: row.department_id,
      defaultProvider: row.default_provider as AgentOrgProvider,
      defaultEffort: row.default_effort as OrgEffort,
      systemPrompt: row.system_prompt,
    };
  }

  private hydrateAgent(row: OrgAgentDbRow, headIds: Set<string>): OrgAgent {
    return {
      id: row.id,
      name: row.name,
      departmentId: row.department_id,
      roleId: row.role_id,
      kind: row.kind as AgentKind,
      provider: row.provider as AgentOrgProvider,
      slotId: row.slot_id,
      model: row.model,
      effort: row.effort as OrgEffort,
      isHead: headIds.has(row.id),
      isAdmin: row.is_admin === 1,
      status: row.status as OrgAgentStatus,
      bridge: row.bridge as AgentBridge,
      note: row.note,
    };
  }

  private getHeadAgentIds(): Set<string> {
    const ids = new Set<string>();
    for (const dept of this.db.listOrgDepartments()) {
      if (dept.head_agent_id) ids.add(dept.head_agent_id);
    }
    return ids;
  }

  getOrg(): { departments: Department[]; roles: Role[]; agents: OrgAgent[] } {
    const deptRows = this.db.listOrgDepartments();
    const headIds = new Set<string>();
    for (const d of deptRows) {
      if (d.head_agent_id) headIds.add(d.head_agent_id);
    }
    return {
      departments: deptRows.map((d) => this.hydrateDepartment(d)),
      roles: this.db.listOrgRoles().map((r) => this.hydrateRole(r)),
      agents: this.db.listOrgAgents().map((a) => this.hydrateAgent(a, headIds)),
    };
  }

  getDepartment(id: string): Department | null {
    const row = this.db.getOrgDepartment(id);
    return row ? this.hydrateDepartment(row) : null;
  }

  getRole(id: string): Role | null {
    const row = this.db.getOrgRole(id);
    return row ? this.hydrateRole(row) : null;
  }

  getAgent(id: string): OrgAgent | null {
    const row = this.db.getOrgAgent(id);
    if (!row) return null;
    return this.hydrateAgent(row, this.getHeadAgentIds());
  }

  listAgentsInDepartment(departmentId: string): OrgAgent[] {
    const headIds = this.getHeadAgentIds();
    return this.db
      .listOrgAgents()
      .filter((a) => a.department_id === departmentId)
      .map((a) => this.hydrateAgent(a, headIds));
  }

  isAdmin(actorId: string): boolean {
    const row = this.db.getOrgAgent(actorId);
    return Boolean(row && row.is_admin === 1);
  }

  isDepartmentHead(actorId: string, departmentId?: string): boolean {
    if (departmentId) {
      const dept = this.db.getOrgDepartment(departmentId);
      return Boolean(dept && dept.head_agent_id === actorId);
    }
    return this.db.listOrgDepartments().some((d) => d.head_agent_id === actorId);
  }

  requireAdmin(actorId: string): OrgAgent {
    const agent = this.getAgent(actorId);
    if (!agent || !agent.isAdmin) {
      throw new OrgError(403, "Admin permission required", "admin_only");
    }
    return agent;
  }

  canOpenMeeting(actorId: string): boolean {
    return this.isAdmin(actorId) || this.isDepartmentHead(actorId);
  }

  canCloseOrResumeConversation(actorId: string, createdBy: string): boolean {
    return this.isAdmin(actorId) || actorId === createdBy;
  }

  canAssignTask(actorId: string, departmentId: string): boolean {
    return this.isAdmin(actorId) || this.isDepartmentHead(actorId, departmentId);
  }

  createAgent(
    actorId: string,
    input: {
      id?: string;
      name: string;
      departmentId: string;
      roleId: string;
      kind?: AgentKind;
      provider?: AgentOrgProvider;
      slotId?: string | null;
      model?: string | null;
      effort?: OrgEffort;
      isAdmin?: boolean;
      status?: OrgAgentStatus;
      bridge?: AgentBridge;
      note?: string | null;
    }
  ): OrgAgent {
    this.requireAdmin(actorId);

    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new OrgError(400, "Agent name is required");

    const dept = this.db.getOrgDepartment(input.departmentId);
    if (!dept) throw new OrgError(400, `Department not found: ${input.departmentId}`);

    const role = this.db.getOrgRole(input.roleId);
    if (!role) throw new OrgError(400, `Role not found: ${input.roleId}`);

    const kind: AgentKind = input.kind ?? "local_agent";
    if (!VALID_KINDS.has(kind)) throw new OrgError(400, `Invalid kind: ${String(kind)}`);

    const provider: AgentOrgProvider =
      input.provider ?? (role.default_provider as AgentOrgProvider);
    if (!VALID_PROVIDERS.has(provider)) {
      throw new OrgError(400, `Invalid provider: ${String(provider)}`);
    }

    const effort: OrgEffort = input.effort ?? (role.default_effort as OrgEffort);
    if (!VALID_EFFORTS.has(effort)) throw new OrgError(400, `Invalid effort: ${String(effort)}`);

    const bridge: AgentBridge =
      input.bridge ?? (provider === "antigravity" ? "hub" : "none");
    if (!VALID_BRIDGES.has(bridge)) throw new OrgError(400, `Invalid bridge: ${String(bridge)}`);

    const status: OrgAgentStatus =
      input.status ??
      (kind === "human" ? "online" : kind === "grok_bot" ? "manual" : "idle");
    if (!VALID_STATUSES.has(status)) throw new OrgError(400, `Invalid status: ${String(status)}`);

    let id = typeof input.id === "string" && input.id.trim() ? slugifyId(input.id.trim()) : slugifyId(name);
    if (this.db.getOrgAgent(id)) {
      if (input.id) {
        throw new OrgError(409, `Agent already exists: ${id}`);
      }
      let counter = 2;
      while (this.db.getOrgAgent(`${id}-${counter}`)) {
        counter += 1;
      }
      id = `${id}-${counter}`;
    }

    const row: OrgAgentDbRow = {
      id,
      name,
      department_id: dept.id,
      role_id: role.id,
      kind,
      provider,
      slot_id: input.slotId !== undefined ? input.slotId : provider === "antigravity" ? "default" : null,
      model: input.model ?? null,
      effort,
      is_admin: input.isAdmin ? 1 : 0,
      status,
      bridge,
      note: input.note ?? null,
    };
    this.db.upsertOrgAgent(row);
    this.emitOrgChanged();
    return this.hydrateAgent(row, this.getHeadAgentIds());
  }

  patchAgent(
    actorId: string,
    id: string,
    patch: {
      name?: string;
      departmentId?: string;
      roleId?: string;
      kind?: AgentKind;
      provider?: AgentOrgProvider;
      slotId?: string | null;
      model?: string | null;
      effort?: OrgEffort;
      isAdmin?: boolean;
      status?: OrgAgentStatus;
      bridge?: AgentBridge;
      note?: string | null;
    }
  ): OrgAgent {
    this.requireAdmin(actorId);

    const row = this.db.getOrgAgent(id);
    if (!row) throw new OrgError(404, `Agent not found: ${id}`);

    if (patch.name !== undefined) {
      if (typeof patch.name !== "string" || !patch.name.trim()) {
        throw new OrgError(400, "Agent name must be non-empty");
      }
      row.name = patch.name.trim();
    }
    if (patch.departmentId !== undefined) {
      if (!this.db.getOrgDepartment(patch.departmentId)) {
        throw new OrgError(400, `Department not found: ${patch.departmentId}`);
      }
      row.department_id = patch.departmentId;
    }
    if (patch.roleId !== undefined) {
      if (!this.db.getOrgRole(patch.roleId)) {
        throw new OrgError(400, `Role not found: ${patch.roleId}`);
      }
      row.role_id = patch.roleId;
    }
    if (patch.kind !== undefined) {
      if (!VALID_KINDS.has(patch.kind)) throw new OrgError(400, `Invalid kind: ${String(patch.kind)}`);
      row.kind = patch.kind;
    }
    if (patch.provider !== undefined) {
      if (!VALID_PROVIDERS.has(patch.provider)) {
        throw new OrgError(400, `Invalid provider: ${String(patch.provider)}`);
      }
      row.provider = patch.provider;
    }
    if (patch.slotId !== undefined) row.slot_id = patch.slotId;
    if (patch.model !== undefined) row.model = patch.model;
    if (patch.effort !== undefined) {
      if (!VALID_EFFORTS.has(patch.effort)) {
        throw new OrgError(400, `Invalid effort: ${String(patch.effort)}`);
      }
      row.effort = patch.effort;
    }
    if (patch.isAdmin !== undefined) {
      if (PROTECTED_SEED_IDS.has(id) && !patch.isAdmin) {
        throw new OrgError(400, "Cannot remove admin flag from seeded admin");
      }
      row.is_admin = patch.isAdmin ? 1 : 0;
    }
    if (patch.status !== undefined) {
      if (!VALID_STATUSES.has(patch.status)) {
        throw new OrgError(400, `Invalid status: ${String(patch.status)}`);
      }
      row.status = patch.status;
    }
    if (patch.bridge !== undefined) {
      if (!VALID_BRIDGES.has(patch.bridge)) {
        throw new OrgError(400, `Invalid bridge: ${String(patch.bridge)}`);
      }
      row.bridge = patch.bridge;
    }
    if (patch.note !== undefined) row.note = patch.note;

    this.db.upsertOrgAgent(row);
    this.emitOrgChanged();
    return this.hydrateAgent(row, this.getHeadAgentIds());
  }

  deleteAgent(actorId: string, id: string): { ok: true } {
    this.requireAdmin(actorId);

    const row = this.db.getOrgAgent(id);
    if (!row) throw new OrgError(404, `Agent not found: ${id}`);

    if (PROTECTED_SEED_IDS.has(id) || row.kind === "human" || row.is_admin === 1) {
      throw new OrgError(400, "Seeded humans and admins cannot be deleted", "protected_agent");
    }

    this.db.clearOrgDepartmentHeadForAgent(id);
    this.db.deleteOrgAgent(id);
    this.emitOrgChanged();
    return { ok: true };
  }

  patchDepartment(
    actorId: string,
    id: string,
    patch: { headAgentId: string | null }
  ): Department {
    this.requireAdmin(actorId);

    const dept = this.db.getOrgDepartment(id);
    if (!dept) throw new OrgError(404, `Department not found: ${id}`);

    if (patch.headAgentId !== null && patch.headAgentId !== undefined) {
      if (typeof patch.headAgentId !== "string" || !this.db.getOrgAgent(patch.headAgentId)) {
        throw new OrgError(400, `Agent not found: ${String(patch.headAgentId)}`);
      }
    }

    const nextHead = patch.headAgentId ?? null;
    this.db.updateOrgDepartmentHead(id, nextHead);
    this.emitOrgChanged();
    return { id: dept.id, name: dept.name, headAgentId: nextHead };
  }
}
