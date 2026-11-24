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
