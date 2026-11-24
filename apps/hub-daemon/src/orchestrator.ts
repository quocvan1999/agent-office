import type { AgentAdapter, AgentEvent, AgentProvider } from "../../../packages/protocol/src/events.ts";
import type { OfficeDatabase } from "./db.ts";

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

interface ActiveSession {
  sessionId: string;
  taskId: string;
  agentId: string;
  adapter: AgentAdapter;
}

export class HubOrchestrator {
  private sessions = new Map<string, ActiveSession>();
  private approvals = new Map<string, PendingApproval>();
  private approvalResolvers = new Map<string, (approved: boolean) => void>();
  private listeners = new Set<(event: AgentEvent) => void>();

  constructor(private readonly db: OfficeDatabase) {}

  subscribe(fn: (event: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: AgentEvent): void {
    this.db.recordEvent(event);
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // isolate subscriber errors
      }
    }
  }

  registerSession(session: ActiveSession): void {
    this.sessions.set(session.sessionId, session);
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  listPendingApprovals(): PendingApproval[] {
    return Array.from(this.approvals.values()).filter((a) => a.status === "pending");
  }

  requestApproval(input: {
    taskId: string;
    agentId: string;
    provider: AgentProvider;
    action: string;
    detail: string;
  }): { approval: PendingApproval; decision: Promise<boolean> } {
    const id = crypto.randomUUID();
    const approval: PendingApproval = {
      id,
      ...input,
      createdAt: Date.now(),
      status: "pending",
    };
    this.approvals.set(id, approval);

    this.emit({
      id: crypto.randomUUID(),
      ts: Date.now(),
      agentId: input.agentId,
      provider: input.provider,
      taskId: input.taskId,
      status: "waiting_approval",
      approvalId: id,
      summary: `Waiting approval: ${input.action}`,
    });

    const decision = new Promise<boolean>((resolve) => {
      this.approvalResolvers.set(id, resolve);
    });
    return { approval, decision };
  }

  resolveApproval(id: string, approved: boolean): PendingApproval | undefined {
    const item = this.approvals.get(id);
    if (!item || item.status !== "pending") return undefined;
    item.status = approved ? "approved" : "denied";
    const resolver = this.approvalResolvers.get(id);
    if (resolver) {
      resolver(approved);
      this.approvalResolvers.delete(id);
    }
    return item;
  }

  async stopAll(reason = "Emergency Stop All triggered"): Promise<{ stoppedSessions: number; deniedApprovals: number }> {
    const active = Array.from(this.sessions.values());
    let stoppedSessions = 0;
    for (const session of active) {
      await session.adapter.abort(session.sessionId);
      this.sessions.delete(session.sessionId);
      stoppedSessions += 1;
      this.emit({
        id: crypto.randomUUID(),
        ts: Date.now(),
        agentId: session.agentId,
        provider: session.adapter.provider,
        taskId: session.taskId,
        status: "stopped",
        summary: reason,
      });
    }

    let deniedApprovals = 0;
    for (const pending of this.listPendingApprovals()) {
      this.resolveApproval(pending.id, false);
      deniedApprovals += 1;
    }

    return { stoppedSessions, deniedApprovals };
  }
}
