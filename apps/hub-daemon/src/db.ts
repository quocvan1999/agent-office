import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AgentEvent } from "../../../packages/protocol/src/events.ts";
import { ensureDataDirLayout } from "./policy.ts";

export class OfficeDatabase {
  readonly dbPath: string;
  private db: Database;

  constructor(customPath?: string) {
    const dataDir = ensureDataDirLayout();
    this.dbPath = customPath ?? join(dataDir, "db", "office.sqlite");
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_profile TEXT,
        status TEXT NOT NULL,
        worktree_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        tool_name TEXT,
        approval_id TEXT,
        telemetry_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_task_ts ON events(task_id, ts);

      CREATE TABLE IF NOT EXISTS audit_reports (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        report_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_reports_at ON audit_reports(at);

      CREATE TABLE IF NOT EXISTS slots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        home_dir TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        model TEXT,
        effort TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'unknown',
        email TEXT,
        models_json TEXT NOT NULL DEFAULT '[]',
        quota_json TEXT NOT NULL DEFAULT '[]',
        credits REAL,
        cooldown_until TEXT,
        last_quota_error_json TEXT,
        manual_json TEXT NOT NULL DEFAULT '{}',
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_rows (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        used_pct REAL,
        share_pct REAL,
        reset_at TEXT,
        reset_rule TEXT,
        limit_note TEXT,
        note TEXT,
        source TEXT NOT NULL DEFAULT 'none',
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS slot_usage (
        slot_id TEXT PRIMARY KEY,
        requests INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        last_job_at TEXT
      );

      CREATE TABLE IF NOT EXISTS org_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_departments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        head_agent_id TEXT
      );

      CREATE TABLE IF NOT EXISTS org_roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        department_id TEXT NOT NULL,
        default_provider TEXT NOT NULL,
        default_effort TEXT NOT NULL,
        system_prompt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        department_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        slot_id TEXT,
        model TEXT,
        effort TEXT NOT NULL DEFAULT 'low',
        is_admin INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'offline',
        bridge TEXT NOT NULL DEFAULT 'none',
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS bus_conversations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        participants_json TEXT NOT NULL,
        status TEXT NOT NULL,
        turn_cap INTEGER NOT NULL DEFAULT 12,
        turns INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        task_id TEXT,
        summary TEXT,
        pause_reason TEXT,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_bus_conv_status_opened ON bus_conversations(status, opened_at);

      CREATE TABLE IF NOT EXISTS bus_messages (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        from_agent_id TEXT NOT NULL,
        to_agent_id TEXT,
        conversation_id TEXT NOT NULL,
        task_id TEXT,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT,
        token_estimate INTEGER NOT NULL,
        status TEXT NOT NULL,
        reject_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_bus_msg_conv_ts ON bus_messages(conversation_id, ts);
      CREATE INDEX IF NOT EXISTS idx_bus_msg_ts ON bus_messages(ts);

      CREATE TABLE IF NOT EXISTS org_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_agent_id TEXT NOT NULL,
        department_id TEXT NOT NULL,
        to_agent_id TEXT,
        summary TEXT NOT NULL,
        decisions_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        conversation_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_org_tasks_created ON org_tasks(created_at);
    `);
  }

  recordEvent(event: AgentEvent) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO events
      (id, ts, agent_id, provider, task_id, status, summary, tool_name, approval_id, telemetry_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.id,
      event.ts,
      event.agentId,
      event.provider,
      event.taskId ?? null,
      event.status,
      event.summary,
      event.toolName ?? null,
      event.approvalId ?? null,
      event.telemetry ? JSON.stringify(event.telemetry) : null
    );
  }

  listRecentEvents(limit = 50): AgentEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, agent_id, provider, task_id, status, summary, tool_name, approval_id, telemetry_json
         FROM events ORDER BY ts DESC LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      ts: Number(r.ts),
      agentId: String(r.agent_id),
      provider: r.provider as AgentEvent["provider"],
      taskId: r.task_id ? String(r.task_id) : undefined,
      status: r.status as AgentEvent["status"],
      summary: String(r.summary),
      toolName: r.tool_name ? String(r.tool_name) : undefined,
      approvalId: r.approval_id ? String(r.approval_id) : undefined,
      telemetry: r.telemetry_json ? JSON.parse(String(r.telemetry_json)) : undefined,
    }));
  }

  saveAuditReport(report: { id: string; at: string; kind: string }) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO audit_reports (id, at, kind, report_json)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(report.id, report.at, report.kind, JSON.stringify(report));
  }

  getLatestAuditReport<T>(): T | null {
    const row = this.db
      .prepare(`SELECT report_json FROM audit_reports ORDER BY at DESC LIMIT 1`)
      .get() as { report_json?: string } | null;
    if (!row?.report_json) return null;
    try {
      return JSON.parse(row.report_json) as T;
    } catch {
      return null;
    }
  }

  listSlotRows(): SlotDbRow[] {
    return this.db
      .prepare(`SELECT * FROM slots ORDER BY is_default DESC, created_at ASC`)
      .all() as SlotDbRow[];
  }

  getSlotRow(id: string): SlotDbRow | null {
    return (this.db.prepare(`SELECT * FROM slots WHERE id = ?`).get(id) as SlotDbRow | null) ?? null;
  }

  insertSlotIfNotExists(row: SlotDbRow): boolean {
    const res = this.db
      .prepare(`
        INSERT OR IGNORE INTO slots (
          id, name, home_dir, is_default, enabled, model, effort, status, email,
          models_json, quota_json, credits, cooldown_until, last_quota_error_json,
          manual_json, last_checked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.name,
        row.home_dir,
        row.is_default,
        row.enabled,
        row.model,
        row.effort,
        row.status,
        row.email,
        row.models_json,
        row.quota_json,
        row.credits,
        row.cooldown_until,
        row.last_quota_error_json,
        row.manual_json,
        row.last_checked_at,
        row.created_at,
        row.updated_at
      );
    return res.changes > 0;
  }

  upsertSlotRow(row: SlotDbRow): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO slots (
          id, name, home_dir, is_default, enabled, model, effort, status, email,
          models_json, quota_json, credits, cooldown_until, last_quota_error_json,
          manual_json, last_checked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.name,
        row.home_dir,
        row.is_default,
        row.enabled,
        row.model,
        row.effort,
        row.status,
        row.email,
        row.models_json,
        row.quota_json,
        row.credits,
        row.cooldown_until,
        row.last_quota_error_json,
        row.manual_json,
        row.last_checked_at,
        row.created_at,
        row.updated_at
      );
  }

  deleteSlotRow(id: string): void {
    this.db.prepare(`DELETE FROM slots WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM slot_usage WHERE slot_id = ?`).run(id);
  }

  listSlotUsage(): Map<string, SlotUsageRow> {
    const rows = this.db
      .prepare(`SELECT slot_id, requests, total_tokens, last_job_at FROM slot_usage`)
      .all() as SlotUsageRow[];
    const map = new Map<string, SlotUsageRow>();
    for (const r of rows) {
      map.set(r.slot_id, r);
    }
    return map;
  }

  getSlotUsage(slotId: string): SlotUsageRow {
    const row = this.db
      .prepare(`SELECT slot_id, requests, total_tokens, last_job_at FROM slot_usage WHERE slot_id = ?`)
      .get(slotId) as SlotUsageRow | null;
    return row ?? { slot_id: slotId, requests: 0, total_tokens: 0, last_job_at: null };
  }

  incrementSlotUsage(slotId: string, tokens: number, at: string): void {
    this.db
      .prepare(`
        INSERT INTO slot_usage (slot_id, requests, total_tokens, last_job_at)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(slot_id) DO UPDATE SET
          requests = requests + 1,
          total_tokens = total_tokens + excluded.total_tokens,
          last_job_at = excluded.last_job_at
      `)
      .run(slotId, Math.max(0, Math.round(tokens)), at);
  }

  insertProviderRowIfNotExists(row: ProviderDbRow): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO provider_rows (
          id, label, kind, used_pct, share_pct, reset_at, reset_rule, limit_note, note, source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.label,
        row.kind,
        row.used_pct,
        row.share_pct,
        row.reset_at,
        row.reset_rule,
        row.limit_note,
        row.note,
        row.source,
        row.updated_at
      );
  }

  listProviderRows(): ProviderDbRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_rows ORDER BY rowid ASC`)
      .all() as ProviderDbRow[];
  }

  getProviderRow(id: string): ProviderDbRow | null {
    return (
      (this.db.prepare(`SELECT * FROM provider_rows WHERE id = ?`).get(id) as ProviderDbRow | null) ??
      null
    );
  }

  updateProviderRow(row: ProviderDbRow): void {
    this.db
      .prepare(`
        UPDATE provider_rows
        SET label = ?, kind = ?, used_pct = ?, share_pct = ?, reset_at = ?,
            reset_rule = ?, limit_note = ?, note = ?, source = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        row.label,
        row.kind,
        row.used_pct,
        row.share_pct,
        row.reset_at,
        row.reset_rule,
        row.limit_note,
        row.note,
        row.source,
        row.updated_at,
        row.id
      );
  }

  getOrgMeta(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM org_meta WHERE key = ?`)
      .get(key) as { value?: string } | null;
    return row?.value ?? null;
  }

  setOrgMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO org_meta (key, value) VALUES (?, ?)`)
      .run(key, value);
  }

  listOrgDepartments(): OrgDepartmentDbRow[] {
    return this.db
      .prepare(`SELECT * FROM org_departments ORDER BY rowid ASC`)
      .all() as OrgDepartmentDbRow[];
  }

  getOrgDepartment(id: string): OrgDepartmentDbRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM org_departments WHERE id = ?`)
        .get(id) as OrgDepartmentDbRow | null) ?? null
    );
  }

  insertOrgDepartmentIfNotExists(row: OrgDepartmentDbRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO org_departments (id, name, head_agent_id) VALUES (?, ?, ?)`
      )
      .run(row.id, row.name, row.head_agent_id);
  }

  updateOrgDepartmentHead(id: string, headAgentId: string | null): void {
    this.db
      .prepare(`UPDATE org_departments SET head_agent_id = ? WHERE id = ?`)
      .run(headAgentId, id);
  }

  clearOrgDepartmentHeadForAgent(agentId: string): void {
    this.db
      .prepare(`UPDATE org_departments SET head_agent_id = NULL WHERE head_agent_id = ?`)
      .run(agentId);
  }

  listOrgRoles(): OrgRoleDbRow[] {
    return this.db
      .prepare(`SELECT * FROM org_roles ORDER BY rowid ASC`)
      .all() as OrgRoleDbRow[];
  }

  getOrgRole(id: string): OrgRoleDbRow | null {
    return (
      (this.db.prepare(`SELECT * FROM org_roles WHERE id = ?`).get(id) as OrgRoleDbRow | null) ??
      null
    );
  }

  insertOrgRoleIfNotExists(row: OrgRoleDbRow): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO org_roles (
          id, name, department_id, default_provider, default_effort, system_prompt
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.name,
        row.department_id,
        row.default_provider,
        row.default_effort,
        row.system_prompt
      );
  }

  listOrgAgents(): OrgAgentDbRow[] {
    return this.db
      .prepare(`SELECT * FROM org_agents ORDER BY rowid ASC`)
      .all() as OrgAgentDbRow[];
  }

  getOrgAgent(id: string): OrgAgentDbRow | null {
    return (
      (this.db.prepare(`SELECT * FROM org_agents WHERE id = ?`).get(id) as OrgAgentDbRow | null) ??
      null
    );
  }

  insertOrgAgentIfNotExists(row: OrgAgentDbRow): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO org_agents (
          id, name, department_id, role_id, kind, provider, slot_id, model, effort, is_admin, status, bridge, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.name,
        row.department_id,
        row.role_id,
        row.kind,
        row.provider,
        row.slot_id,
        row.model,
        row.effort,
        row.is_admin,
        row.status,
        row.bridge,
        row.note
      );
  }

  upsertOrgAgent(row: OrgAgentDbRow): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO org_agents (
          id, name, department_id, role_id, kind, provider, slot_id, model, effort, is_admin, status, bridge, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.name,
        row.department_id,
        row.role_id,
        row.kind,
        row.provider,
        row.slot_id,
        row.model,
        row.effort,
        row.is_admin,
        row.status,
        row.bridge,
        row.note
      );
  }

  deleteOrgAgent(id: string): void {
    this.db.prepare(`DELETE FROM org_agents WHERE id = ?`).run(id);
  }

  insertBusConversation(row: BusConversationDbRow): void {
    this.db
      .prepare(`
        INSERT INTO bus_conversations (
          id, type, title, participants_json, status, turn_cap, turns, created_by,
          task_id, summary, pause_reason, opened_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.type,
        row.title,
        row.participants_json,
        row.status,
        row.turn_cap,
        row.turns,
        row.created_by,
        row.task_id,
        row.summary,
        row.pause_reason,
        row.opened_at,
        row.closed_at
      );
  }

  updateBusConversation(row: BusConversationDbRow): void {
    this.db
      .prepare(`
        UPDATE bus_conversations
        SET title = ?, participants_json = ?, status = ?, turn_cap = ?, turns = ?,
            task_id = ?, summary = ?, pause_reason = ?, closed_at = ?
        WHERE id = ?
      `)
      .run(
        row.title,
        row.participants_json,
        row.status,
        row.turn_cap,
        row.turns,
        row.task_id,
        row.summary,
        row.pause_reason,
        row.closed_at,
        row.id
      );
  }

  getBusConversation(id: string): BusConversationDbRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM bus_conversations WHERE id = ?`)
        .get(id) as BusConversationDbRow | null) ?? null
    );
  }

  listBusConversations(status?: string): BusConversationDbRow[] {
    if (status && status !== "all") {
      return this.db
        .prepare(`SELECT * FROM bus_conversations WHERE status = ? ORDER BY opened_at DESC`)
        .all(status) as BusConversationDbRow[];
    }
    return this.db
      .prepare(`SELECT * FROM bus_conversations ORDER BY opened_at DESC`)
      .all() as BusConversationDbRow[];
  }

  insertBusMessage(row: BusMessageDbRow): void {
    this.db
      .prepare(`
        INSERT INTO bus_messages (
          id, ts, from_agent_id, to_agent_id, conversation_id, task_id,
          kind, summary, body, token_estimate, status, reject_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.ts,
        row.from_agent_id,
        row.to_agent_id,
        row.conversation_id,
        row.task_id,
        row.kind,
        row.summary,
        row.body,
        row.token_estimate,
        row.status,
        row.reject_reason
      );
  }

  listBusMessages(opts: {
    conversationId?: string;
    limit?: number;
    includeRejected?: boolean;
    order?: "asc" | "desc";
  }): BusMessageDbRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.conversationId) {
      clauses.push("conversation_id = ?");
      params.push(opts.conversationId);
    }
    if (!opts.includeRejected) {
      clauses.push("status = 'delivered'");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const dir = opts.order === "asc" ? "ASC" : "DESC";
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
    params.push(limit);
    return this.db
      .prepare(`SELECT * FROM bus_messages ${where} ORDER BY ts ${dir}, rowid ${dir} LIMIT ?`)
      .all(...params) as BusMessageDbRow[];
  }

  getLastDeliveredBusMessage(conversationId: string): BusMessageDbRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM bus_messages WHERE conversation_id = ? AND status = 'delivered' ORDER BY ts DESC, rowid DESC LIMIT 1`
        )
        .get(conversationId) as BusMessageDbRow | null) ?? null
    );
  }

  insertOrgTask(row: OrgTaskDbRow): void {
    this.db
      .prepare(`
        INSERT INTO org_tasks (
          id, title, kind, from_agent_id, department_id, to_agent_id,
          summary, decisions_json, status, conversation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.title,
        row.kind,
        row.from_agent_id,
        row.department_id,
        row.to_agent_id,
        row.summary,
        row.decisions_json,
        row.status,
        row.conversation_id,
        row.created_at
      );
  }

  listOrgTasks(limit = 200): OrgTaskDbRow[] {
    return this.db
      .prepare(`SELECT * FROM org_tasks ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as OrgTaskDbRow[];
  }

  close() {
    this.db.close();
  }
}

export interface SlotDbRow {
  id: string;
  name: string;
  home_dir: string;
  is_default: number;
  enabled: number;
  model: string | null;
  effort: string;
  status: string;
  email: string | null;
  models_json: string;
  quota_json: string;
  credits: number | null;
  cooldown_until: string | null;
  last_quota_error_json: string | null;
  manual_json: string;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SlotUsageRow {
  slot_id: string;
  requests: number;
  total_tokens: number;
  last_job_at: string | null;
}

export interface ProviderDbRow {
  id: string;
  label: string;
  kind: string;
  used_pct: number | null;
  share_pct: number | null;
  reset_at: string | null;
  reset_rule: string | null;
  limit_note: string | null;
  note: string | null;
  source: string;
  updated_at: string | null;
}

export interface OrgDepartmentDbRow {
  id: string;
  name: string;
  head_agent_id: string | null;
}

export interface OrgRoleDbRow {
  id: string;
  name: string;
  department_id: string;
  default_provider: string;
  default_effort: string;
  system_prompt: string;
}

export interface OrgAgentDbRow {
  id: string;
  name: string;
  department_id: string;
  role_id: string;
  kind: string;
  provider: string;
  slot_id: string | null;
  model: string | null;
  effort: string;
  is_admin: number;
  status: string;
  bridge: string;
  note: string | null;
}

export interface BusConversationDbRow {
  id: string;
  type: string;
  title: string;
  participants_json: string;
  status: string;
  turn_cap: number;
  turns: number;
  created_by: string;
  task_id: string | null;
  summary: string | null;
  pause_reason: string | null;
  opened_at: number;
  closed_at: number | null;
}

export interface BusMessageDbRow {
  id: string;
  ts: number;
  from_agent_id: string;
  to_agent_id: string | null;
  conversation_id: string;
  task_id: string | null;
  kind: string;
  summary: string;
  body: string | null;
  token_estimate: number;
  status: string;
  reject_reason: string | null;
}

export interface OrgTaskDbRow {
  id: string;
  title: string;
  kind: string;
  from_agent_id: string;
  department_id: string;
  to_agent_id: string | null;
  summary: string;
  decisions_json: string;
  status: string;
  conversation_id: string | null;
  created_at: number;
}
