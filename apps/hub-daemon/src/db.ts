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

  close() {
    this.db.close();
  }
}
