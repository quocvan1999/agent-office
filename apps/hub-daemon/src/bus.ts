import {
  BUS_BODY_MAX,
  BUS_HANDOFF_BODY_MAX,
  BUS_SUMMARY_MAX,
  CONVERSATION_SUMMARY_MAX,
  type BusMessage,
  type BusMessageKind,
  type Conversation,
  type ConversationStatus,
  type ConversationType,
  type TaskKind,
  type TaskRecord,
  type TaskStatus,
} from "../../../packages/protocol/src/org.ts";
import type { AccountsService } from "./accounts.ts";
import type {
  BusConversationDbRow,
  BusMessageDbRow,
  OfficeDatabase,
  OrgTaskDbRow,
} from "./db.ts";
import type { HubOrchestrator } from "./orchestrator.ts";
import type { OrgService } from "./org.ts";

export class BusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reason?: string
  ) {
    super(message);
    this.name = "BusError";
  }
}

export interface BusServiceOptions {
  db: OfficeDatabase;
  org: OrgService;
  accounts: AccountsService;
  orchestrator: HubOrchestrator;
  repoRoot?: string;
  onBusMessage?: (message: BusMessage) => void;
  onBusRejected?: (message: BusMessage) => void;
  onConversationChanged?: (conversation: Conversation) => void;
  onGuardrail?: (conversationId: string, reason: string) => void;
}

export interface PostMessageInput {
  fromAgentId: string;
  toAgentId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  kind: BusMessageKind;
  summary: string;
  body?: string | null;
}

export interface CreateConversationInput {
  type?: ConversationType;
  title: string;
  participants: string[];
  turnCap?: number;
  taskId?: string | null;
}

export interface AssignTaskInput {
  title: string;
  departmentId: string;
  toAgentId?: string | null;
  summary: string;
  decisions?: string[];
}

export interface HandoffTaskInput {
  title: string;
  fromAgentId?: string;
  departmentId?: string;
  toDepartmentId?: string;
  toAgentId?: string | null;
  summary: string;
  decisions?: string[];
}

export interface MeetingRunState {
  runId: string;
  conversationId: string;
  status: "running" | "done" | "stopped";
  postedMessageIds: string[];
  skippedParticipants: Array<{ agentId: string; note: string }>;
}

const VALID_KINDS = new Set<BusMessageKind>(["request", "reply", "handoff", "meeting"]);

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function estimateTokens(summary: string, body: string | null): number {
  const chars = summary.length + (body ? body.length : 0);
  return Math.ceil(chars / 4);
}

function normalizeMessageKey(summary: string, body: string | null): string {
  return `${summary}\n${body ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function buildZeroTokenSummary(messages: BusMessage[]): string {
  const joined = messages
    .map((m) => `${m.fromAgentId}: ${m.summary}`)
    .join(" | ");
  return joined.slice(0, CONVERSATION_SUMMARY_MAX);
}

export class BusService {
  private readonly db: OfficeDatabase;
  private readonly org: OrgService;
  private readonly accounts: AccountsService;
  private readonly orchestrator: HubOrchestrator;
  private readonly repoRoot: string;
  private readonly onBusMessage?: (message: BusMessage) => void;
  private readonly onBusRejected?: (message: BusMessage) => void;
  private readonly onConversationChanged?: (conversation: Conversation) => void;
  private readonly onGuardrail?: (conversationId: string, reason: string) => void;

  private runs = new Map<string, MeetingRunState>();
  private runPromises = new Map<string, Promise<void>>();

  constructor(opts: BusServiceOptions) {
    this.db = opts.db;
    this.org = opts.org;
    this.accounts = opts.accounts;
    this.orchestrator = opts.orchestrator;
    this.repoRoot = opts.repoRoot ?? process.cwd();
    this.onBusMessage = opts.onBusMessage;
    this.onBusRejected = opts.onBusRejected;
    this.onConversationChanged = opts.onConversationChanged;
    this.onGuardrail = opts.onGuardrail;
  }

  private hydrateMessage(row: BusMessageDbRow): BusMessage {
    return {
      id: row.id,
      ts: row.ts,
      fromAgentId: row.from_agent_id,
      toAgentId: row.to_agent_id,
      conversationId: row.conversation_id,
      taskId: row.task_id,
      kind: row.kind as BusMessageKind,
      summary: row.summary,
      body: row.body,
      tokenEstimate: row.token_estimate,
      status: row.status as "delivered" | "rejected",
      rejectReason: row.reject_reason,
    };
  }

  private hydrateConversation(row: BusConversationDbRow): Conversation {
    const lastRow = this.db.getLastDeliveredBusMessage(row.id);
    const conv: Conversation = {
      id: row.id,
      type: row.type as ConversationType,
      title: row.title,
      participants: safeJsonParse<string[]>(row.participants_json, []),
      status: row.status as ConversationStatus,
      turnCap: row.turn_cap,
      turns: row.turns,
      createdBy: row.created_by,
      taskId: row.task_id,
      summary: row.summary,
      pauseReason: row.pause_reason,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
    };
    if (lastRow) {
      conv.lastMessage = this.hydrateMessage(lastRow);
    }
    return conv;
  }

  private hydrateTask(row: OrgTaskDbRow): TaskRecord {
    return {
      id: row.id,
      title: row.title,
      kind: row.kind as TaskKind,
      fromAgentId: row.from_agent_id,
      departmentId: row.department_id,
      toAgentId: row.to_agent_id,
      summary: row.summary,
      decisions: safeJsonParse<string[]>(row.decisions_json, []),
      status: row.status as TaskStatus,
      conversationId: row.conversation_id,
      createdAt: row.created_at,
    };
  }

  private emitBusMessage(msg: BusMessage): void {
    try {
      this.onBusMessage?.(msg);
    } catch {
      // isolate callback errors
    }
  }

  private emitBusRejected(msg: BusMessage): void {
    try {
      this.onBusRejected?.(msg);
    } catch {
      // isolate callback errors
    }
  }

  private emitConversationChanged(conv: Conversation): void {
    try {
      this.onConversationChanged?.(conv);
    } catch {
      // isolate callback errors
    }
  }

  private emitGuardrail(conversationId: string, reason: string): void {
    try {
      this.onGuardrail?.(conversationId, reason);
    } catch {
      // isolate callback errors
    }
  }

  private logAndThrowRejected(
    input: {
      fromAgentId: string;
      toAgentId: string | null;
      conversationId: string;
      taskId: string | null;
      kind: BusMessageKind;
      summary: string;
      body: string | null;
    },
    reason: string
  ): never {
    const row: BusMessageDbRow = {
      id: `msg-${crypto.randomUUID().slice(0, 12)}`,
      ts: Date.now(),
      from_agent_id: input.fromAgentId,
      to_agent_id: input.toAgentId,
      conversation_id: input.conversationId,
      task_id: input.taskId,
      kind: input.kind,
      summary: input.summary,
      body: input.body,
      token_estimate: estimateTokens(input.summary, input.body),
      status: "rejected",
      reject_reason: reason,
    };
    this.db.insertBusMessage(row);
    const msg = this.hydrateMessage(row);
    this.emitBusRejected(msg);
    throw new BusError(403, `Message rejected: ${reason}`, reason);
  }

  private findOrCreateDirectConversation(fromId: string, toId: string): BusConversationDbRow {
    const pairKey = [fromId, toId].sort().join("::");
    const openConvs = this.db.listBusConversations("open");
    for (const c of openConvs) {
      if (c.type !== "direct") continue;
      const participants = safeJsonParse<string[]>(c.participants_json, []);
      if (participants.length === 2 && [...participants].sort().join("::") === pairKey) {
        return c;
      }
    }

    const fromAgent = this.org.getAgent(fromId);
    const toAgent = this.org.getAgent(toId);
    const row: BusConversationDbRow = {
      id: `conv-${crypto.randomUUID().slice(0, 10)}`,
      type: "direct",
      title: `${fromAgent?.name ?? fromId} ↔ ${toAgent?.name ?? toId}`,
      participants_json: JSON.stringify([fromId, toId]),
      status: "open",
      turn_cap: 12,
      turns: 0,
      created_by: fromId,
      task_id: null,
      summary: null,
      pause_reason: null,
      opened_at: Date.now(),
      closed_at: null,
    };
    this.db.insertBusConversation(row);
    this.emitConversationChanged(this.hydrateConversation(row));
    return row;
  }

  private applyGuardrails(convRow: BusConversationDbRow): void {
    const deliveredRows = this.db.listBusMessages({
      conversationId: convRow.id,
      limit: 200,
      includeRejected: false,
      order: "asc",
    });
    const delivered = deliveredRows.map((r) => this.hydrateMessage(r));
    if (delivered.length === 0) return;

    // 1. Loop Guard: same normalized summary/body hash 3 times, or A->B->A->B identical texts
    const latest = delivered[delivered.length - 1];
    const latestKey = normalizeMessageKey(latest.summary, latest.body);
    let sameCount = 0;
    for (const m of delivered) {
      if (normalizeMessageKey(m.summary, m.body) === latestKey) {
        sameCount += 1;
      }
    }

    let loopReason: string | null = null;
    if (sameCount >= 3) {
      loopReason = "loop_guard: repeated identical message 3 times";
    } else if (delivered.length >= 4) {
      const [m1, m2, m3, m4] = delivered.slice(-4);
      const isAlternating =
        m1.fromAgentId === m3.fromAgentId &&
        m2.fromAgentId === m4.fromAgentId &&
        m1.fromAgentId !== m2.fromAgentId;
      if (
        isAlternating &&
        normalizeMessageKey(m1.summary, m1.body) === normalizeMessageKey(m3.summary, m3.body) &&
        normalizeMessageKey(m2.summary, m2.body) === normalizeMessageKey(m4.summary, m4.body)
      ) {
        loopReason = "loop_guard: A->B->A->B oscillation detected";
      }
    }

    if (loopReason) {
      convRow.status = "paused";
      convRow.pause_reason = loopReason;
      this.db.updateBusConversation(convRow);
      this.emitConversationChanged(this.hydrateConversation(convRow));
      this.emitGuardrail(convRow.id, loopReason);
      return;
    }

    // 2. Turn cap reached -> auto close with 0-token summary + notify admins
    if (convRow.turns >= convRow.turn_cap) {
      convRow.status = "closed";
      convRow.summary = buildZeroTokenSummary(delivered);
      convRow.closed_at = Date.now();
      this.db.updateBusConversation(convRow);
      this.emitConversationChanged(this.hydrateConversation(convRow));
      this.emitGuardrail(convRow.id, "turn_cap_reached");
      return;
    }

    this.emitConversationChanged(this.hydrateConversation(convRow));
  }

  private deliverMessageToConversation(
    convRow: BusConversationDbRow,
    input: {
      fromAgentId: string;
      toAgentId: string | null;
      taskId: string | null;
      kind: BusMessageKind;
      summary: string;
      body: string | null;
    }
  ): BusMessage {
    const row: BusMessageDbRow = {
      id: `msg-${crypto.randomUUID().slice(0, 12)}`,
      ts: Date.now(),
      from_agent_id: input.fromAgentId,
      to_agent_id: input.toAgentId,
      conversation_id: convRow.id,
      task_id: input.taskId,
      kind: input.kind,
      summary: input.summary,
      body: input.body,
      token_estimate: estimateTokens(input.summary, input.body),
      status: "delivered",
      reject_reason: null,
    };
    this.db.insertBusMessage(row);

    convRow.turns += 1;
    this.db.updateBusConversation(convRow);

    const msg = this.hydrateMessage(row);
    this.emitBusMessage(msg);
    this.applyGuardrails(convRow);
    return msg;
  }

  postMessage(input: PostMessageInput): BusMessage {
    if (!input || typeof input !== "object") {
      throw new BusError(400, "Invalid message payload");
    }
    if (!VALID_KINDS.has(input.kind)) {
      throw new BusError(400, `Invalid message kind: ${String(input.kind)}`);
    }

    const fromAgent = this.org.getAgent(input.fromAgentId);
    if (!fromAgent) {
      throw new BusError(400, `Unknown sender agent: ${input.fromAgentId}`);
    }

    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    if (summary.length < 1 || summary.length > BUS_SUMMARY_MAX) {
      throw new BusError(400, `summary must be 1..${BUS_SUMMARY_MAX} chars`);
    }

    const body =
      input.body === undefined || input.body === null
        ? null
        : typeof input.body === "string"
          ? input.body
          : String(input.body);
    const maxBody = input.kind === "handoff" ? BUS_HANDOFF_BODY_MAX : BUS_BODY_MAX;
    if (body !== null && body.length > maxBody) {
      throw new BusError(400, `body exceeds max length (${maxBody} chars)`);
    }

    const toAgentId = input.toAgentId ?? null;
    const taskId = input.taskId ?? null;
    const requestedConvId = input.conversationId ?? null;

    // Handoff must go through POST /api/tasks/handoff
    if (input.kind === "handoff") {
      this.logAndThrowRejected(
        {
          fromAgentId: fromAgent.id,
          toAgentId,
          conversationId: requestedConvId ?? "rejected",
          taskId,
          kind: input.kind,
          summary,
          body,
        },
        "handoff_must_use_tasks_handoff"
      );
    }

    // Meeting message
    if (input.kind === "meeting") {
      if (!requestedConvId) {
        throw new BusError(400, "conversationId is required for meeting messages");
      }
      const convRow = this.db.getBusConversation(requestedConvId);
      if (!convRow) {
        throw new BusError(404, `Conversation not found: ${requestedConvId}`);
      }
      if (convRow.type !== "meeting") {
        this.logAndThrowRejected(
          {
            fromAgentId: fromAgent.id,
            toAgentId,
            conversationId: convRow.id,
            taskId,
            kind: input.kind,
            summary,
            body,
          },
          "conversation_not_meeting"
        );
      }
      if (convRow.status !== "open") {
        this.logAndThrowRejected(
          {
            fromAgentId: fromAgent.id,
            toAgentId,
            conversationId: convRow.id,
            taskId,
            kind: input.kind,
            summary,
            body,
          },
          convRow.status === "paused" ? "conversation_paused" : "conversation_closed"
        );
      }

      const participants = safeJsonParse<string[]>(convRow.participants_json, []);
      if (!participants.includes(fromAgent.id)) {
        this.logAndThrowRejected(
          {
            fromAgentId: fromAgent.id,
            toAgentId,
            conversationId: convRow.id,
            taskId,
            kind: input.kind,
            summary,
            body,
          },
          "sender_not_participant"
        );
      }
      if (toAgentId && !participants.includes(toAgentId)) {
        this.logAndThrowRejected(
          {
            fromAgentId: fromAgent.id,
            toAgentId,
            conversationId: convRow.id,
            taskId,
            kind: input.kind,
            summary,
            body,
          },
          "recipient_not_participant"
        );
      }

      return this.deliverMessageToConversation(convRow, {
        fromAgentId: fromAgent.id,
        toAgentId,
        taskId: taskId ?? convRow.task_id,
        kind: "meeting",
        summary,
        body,
      });
    }

    // Direct message (request | reply)
    let convRow: BusConversationDbRow | null = null;
    let resolvedToId = toAgentId;

    if (requestedConvId) {
      convRow = this.db.getBusConversation(requestedConvId);
      if (!convRow) {
        throw new BusError(404, `Conversation not found: ${requestedConvId}`);
      }
      if (convRow.status !== "open") {
        this.logAndThrowRejected(
          {
            fromAgentId: fromAgent.id,
            toAgentId: resolvedToId,
            conversationId: convRow.id,
            taskId,
            kind: input.kind,
            summary,
            body,
          },
          convRow.status === "paused" ? "conversation_paused" : "conversation_closed"
        );
      }
      const participants = safeJsonParse<string[]>(convRow.participants_json, []);
      if (!participants.includes(fromAgent.id)) {
        this.logAndThrowRejected(
          {
            fromAgentId: fromAgent.id,
            toAgentId: resolvedToId,
            conversationId: convRow.id,
            taskId,
            kind: input.kind,
            summary,
            body,
          },
          "sender_not_participant"
        );
      }
      if (!resolvedToId) {
        const peer = participants.find((p) => p !== fromAgent.id);
        if (peer) resolvedToId = peer;
      } else if (!participants.includes(resolvedToId)) {
        this.logAndThrowRejected(
          {
            fromAgentId: fromAgent.id,
            toAgentId: resolvedToId,
            conversationId: convRow.id,
            taskId,
            kind: input.kind,
            summary,
            body,
          },
          "recipient_not_participant"
        );
      }
    }

    if (!resolvedToId) {
      throw new BusError(400, "toAgentId is required for direct messages");
    }
    const toAgent = this.org.getAgent(resolvedToId);
    if (!toAgent) {
      throw new BusError(400, `Unknown recipient agent: ${resolvedToId}`);
    }

    const sameDept = fromAgent.departmentId === toAgent.departmentId;
    const eitherBoard = fromAgent.departmentId === "board" || toAgent.departmentId === "board";
    if (!sameDept && !eitherBoard) {
      this.logAndThrowRejected(
        {
          fromAgentId: fromAgent.id,
          toAgentId: toAgent.id,
          conversationId: convRow?.id ?? "rejected",
          taskId,
          kind: input.kind,
          summary,
          body,
        },
        "cross_department_direct_not_allowed"
      );
    }

    if (!convRow) {
      convRow = this.findOrCreateDirectConversation(fromAgent.id, toAgent.id);
    }

    return this.deliverMessageToConversation(convRow, {
      fromAgentId: fromAgent.id,
      toAgentId: toAgent.id,
      taskId: taskId ?? convRow.task_id,
      kind: input.kind,
      summary,
      body,
    });
  }

  listMessages(opts: {
    conversationId?: string;
    limit?: number;
    includeRejected?: boolean;
  }): BusMessage[] {
    return this.db
      .listBusMessages({
        conversationId: opts.conversationId,
        limit: opts.limit ?? 100,
        includeRejected: opts.includeRejected ?? true,
        order: "desc",
      })
      .map((r) => this.hydrateMessage(r));
  }

  listConversations(status?: string): Conversation[] {
    return this.db
      .listBusConversations(status)
      .map((row) => this.hydrateConversation(row));
  }

  getConversationWithMessages(id: string): (Conversation & { messages: BusMessage[] }) | null {
    const row = this.db.getBusConversation(id);
    if (!row) return null;
    const conv = this.hydrateConversation(row);
    const messages = this.db
      .listBusMessages({
        conversationId: id,
        limit: 500,
        includeRejected: true,
        order: "asc",
      })
      .map((r) => this.hydrateMessage(r));
    return { ...conv, messages };
  }

  createConversation(actorId: string, input: CreateConversationInput): Conversation {
    if (!this.org.canOpenMeeting(actorId)) {
      throw new BusError(
        403,
        "Only admins or department heads may open a meeting",
        "open_meeting_forbidden"
      );
    }

    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new BusError(400, "title is required");

    if (!Array.isArray(input.participants) || input.participants.length < 2) {
      throw new BusError(400, "participants must contain at least 2 agent IDs");
    }

    const uniqueParticipants = Array.from(
      new Set(input.participants.map((p) => String(p).trim()).filter(Boolean))
    );
    if (uniqueParticipants.length < 2) {
      throw new BusError(400, "participants must contain at least 2 distinct agent IDs");
    }
    for (const pid of uniqueParticipants) {
      if (!this.org.getAgent(pid)) {
        throw new BusError(400, `Unknown participant agent: ${pid}`);
      }
    }

    const rawCap = input.turnCap ?? 12;
    if (!Number.isInteger(rawCap) || rawCap < 1 || rawCap > 100) {
      throw new BusError(400, "turnCap must be an integer between 1 and 100");
    }

    const row: BusConversationDbRow = {
      id: `conv-${crypto.randomUUID().slice(0, 10)}`,
      type: input.type ?? "meeting",
      title,
      participants_json: JSON.stringify(uniqueParticipants),
      status: "open",
      turn_cap: rawCap,
      turns: 0,
      created_by: actorId,
      task_id: input.taskId ?? null,
      summary: null,
      pause_reason: null,
      opened_at: Date.now(),
      closed_at: null,
    };
    this.db.insertBusConversation(row);
    const conv = this.hydrateConversation(row);
    this.emitConversationChanged(conv);
    return conv;
  }

  closeConversation(actorId: string, id: string, summary?: string): Conversation {
    const row = this.db.getBusConversation(id);
    if (!row) throw new BusError(404, `Conversation not found: ${id}`);

    if (!this.org.canCloseOrResumeConversation(actorId, row.created_by)) {
      throw new BusError(
        403,
        "Only admins or the creator may close this conversation",
        "close_forbidden"
      );
    }

    const delivered = this.db
      .listBusMessages({
        conversationId: id,
        limit: 200,
        includeRejected: false,
        order: "asc",
      })
      .map((r) => this.hydrateMessage(r));

    const trimmedSummary = typeof summary === "string" && summary.trim() ? summary.trim() : null;
    row.status = "closed";
    row.closed_at = Date.now();
    row.summary =
      trimmedSummary ??
      row.summary ??
      (delivered.length > 0 ? buildZeroTokenSummary(delivered) : null);

    this.db.updateBusConversation(row);
    const conv = this.hydrateConversation(row);
    this.emitConversationChanged(conv);
    return conv;
  }

  resumeConversation(actorId: string, id: string): Conversation {
    const row = this.db.getBusConversation(id);
    if (!row) throw new BusError(404, `Conversation not found: ${id}`);

    if (!this.org.canCloseOrResumeConversation(actorId, row.created_by)) {
      throw new BusError(
        403,
        "Only admins or the creator may resume this conversation",
        "resume_forbidden"
      );
    }

    row.status = "open";
    row.pause_reason = null;
    row.closed_at = null;
    if (row.turns >= row.turn_cap) {
      row.turn_cap = row.turns + 6;
    }

    this.db.updateBusConversation(row);
    const conv = this.hydrateConversation(row);
    this.emitConversationChanged(conv);
    return conv;
  }

  getRun(runId: string): MeetingRunState | null {
    const s = this.runs.get(runId);
    return s
      ? {
          ...s,
          postedMessageIds: [...s.postedMessageIds],
          skippedParticipants: [...s.skippedParticipants],
        }
      : null;
  }

  async waitForRun(runId: string): Promise<MeetingRunState | null> {
    const p = this.runPromises.get(runId);
    if (p) await p;
    return this.getRun(runId);
  }

  startMeetingRun(
    conversationId: string,
    input: { rounds?: number; prompt: string }
  ): { ok: true; runId: string } {
    const convRow = this.db.getBusConversation(conversationId);
    if (!convRow) throw new BusError(404, `Conversation not found: ${conversationId}`);
    if (convRow.status !== "open") {
      throw new BusError(400, `Conversation is ${convRow.status}, cannot run`);
    }

    const rounds = input.rounds ?? 1;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) {
      throw new BusError(400, "rounds must be an integer between 1 and 3");
    }

    const topicPrompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!topicPrompt) {
      throw new BusError(400, "prompt is required");
    }

    const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
    const state: MeetingRunState = {
      runId,
      conversationId,
      status: "running",
      postedMessageIds: [],
      skippedParticipants: [],
    };
    this.runs.set(runId, state);

    const p = this.executeMeetingRun(state, rounds, topicPrompt);
    this.runPromises.set(runId, p);
    return { ok: true, runId };
  }

  private async executeMeetingRun(
    state: MeetingRunState,
    rounds: number,
    topicPrompt: string
  ): Promise<void> {
    try {
      for (let round = 1; round <= rounds; round++) {
        const convRow = this.db.getBusConversation(state.conversationId);
        if (!convRow || convRow.status !== "open") {
          state.status = "stopped";
          return;
        }
        const participants = safeJsonParse<string[]>(convRow.participants_json, []);

        for (const participantId of participants) {
          const latestConv = this.db.getBusConversation(state.conversationId);
          if (!latestConv || latestConv.status !== "open") {
            state.status = "stopped";
            return;
          }

          const agent = this.org.getAgent(participantId);
          if (!agent) continue;

          if (agent.bridge !== "hub") {
            const note = `Bỏ qua ${agent.name} (${agent.id}): chưa có cầu nối Hub (bridge=${agent.bridge}).`;
            state.skippedParticipants.push({ agentId: agent.id, note });
            this.orchestrator.emit({
              id: crypto.randomUUID(),
              ts: Date.now(),
              agentId: agent.id,
              provider: "antigravity",
              taskId: state.runId,
              status: "idle",
              summary: note,
            });
            continue;
          }

          const role = this.org.getRole(agent.roleId);
          const recentMsgs = this.db
            .listBusMessages({
              conversationId: state.conversationId,
              limit: 3,
              includeRejected: false,
              order: "desc",
            })
            .reverse()
            .map((r) => this.hydrateMessage(r));

          const promptSections: string[] = [];
          if (role?.systemPrompt) {
            promptSections.push(`Vai trò (${agent.name}): ${role.systemPrompt}`);
          } else {
            promptSections.push(`Vai trò: ${agent.name} (${agent.id})`);
          }
          promptSections.push(`Chủ đề cuộc họp (${latestConv.title}): ${topicPrompt}`);
          if (latestConv.summary) {
            promptSections.push(`Tóm tắt cuộc họp: ${latestConv.summary}`);
          }
          if (recentMsgs.length > 0) {
            const recentText = recentMsgs
              .map((m) => `- ${m.fromAgentId}: ${m.summary}`)
              .join("\n");
            promptSections.push(`3 lượt tóm tắt gần nhất:\n${recentText}`);
          }
          promptSections.push(
            `Vòng ${round}/${rounds}. Hãy trả lời ngắn gọn tối đa 120 từ. Dòng đầu tiên là 1 câu tóm tắt (<= 200 ký tự).`
          );

          const turnResult = await this.accounts.runPinnedTurn({
            slotId: agent.slotId ?? "default",
            prompt: promptSections.join("\n\n"),
            cwd: this.repoRoot,
            model: agent.model ?? undefined,
            effort: agent.effort,
            agentId: agent.id,
            taskId: state.runId,
            printTimeout: "120s",
          });

          const rawText = turnResult.text.trim();
          let summary: string;
          let body: string | null;
          if (rawText) {
            const lines = rawText
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            summary = (lines[0] ?? rawText).slice(0, BUS_SUMMARY_MAX);
            body = rawText.slice(0, BUS_BODY_MAX);
          } else {
            summary = `(${agent.name} không có phản hồi: ${turnResult.error ?? "empty"})`.slice(
              0,
              BUS_SUMMARY_MAX
            );
            body = null;
          }

          try {
            const posted = this.postMessage({
              fromAgentId: agent.id,
              conversationId: state.conversationId,
              taskId: latestConv.task_id,
              kind: "meeting",
              summary,
              body,
            });
            state.postedMessageIds.push(posted.id);
          } catch {
            // Conversation may have closed/paused due to guardrail
            state.status = "stopped";
            return;
          }
        }
      }
      state.status = "done";
    } catch {
      state.status = "stopped";
    }
  }

  assignTask(actorId: string, input: AssignTaskInput): TaskRecord {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new BusError(400, "title is required");

    const dept = this.org.getDepartment(input.departmentId);
    if (!dept) throw new BusError(400, `Department not found: ${input.departmentId}`);

    if (!this.org.canAssignTask(actorId, dept.id)) {
      throw new BusError(
        403,
        "Only admins or the head of this department may assign tasks here",
        "assign_permission_denied"
      );
    }

    if (input.toAgentId) {
      if (!this.org.getAgent(input.toAgentId)) {
        throw new BusError(400, `Target agent not found: ${input.toAgentId}`);
      }
    }

    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    if (!summary) throw new BusError(400, "summary is required");

    const decisions = Array.isArray(input.decisions)
      ? input.decisions.map((d) => String(d).trim()).filter(Boolean)
      : [];

    const row: OrgTaskDbRow = {
      id: `task-${crypto.randomUUID().slice(0, 10)}`,
      title,
      kind: "assign",
      from_agent_id: actorId,
      department_id: dept.id,
      to_agent_id: input.toAgentId ?? null,
      summary: summary.slice(0, BUS_HANDOFF_BODY_MAX),
      decisions_json: JSON.stringify(decisions),
      status: "assigned",
      conversation_id: null,
      created_at: Date.now(),
    };
    this.db.insertOrgTask(row);
    return this.hydrateTask(row);
  }

  handoffTask(
    actorId: string,
    input: HandoffTaskInput
  ): TaskRecord & { conversation: Conversation; message: BusMessage } {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new BusError(400, "title is required");

    const fromAgentId = input.fromAgentId?.trim() || actorId;
    const fromAgent = this.org.getAgent(fromAgentId);
    if (!fromAgent) throw new BusError(400, `Unknown sender agent: ${fromAgentId}`);

    const targetDeptId = input.toDepartmentId ?? input.departmentId ?? "";
    const targetDept = this.org.getDepartment(targetDeptId);
    if (!targetDept) throw new BusError(400, `Target department not found: ${targetDeptId}`);

    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    if (!summary) throw new BusError(400, "summary is required");

    const decisions = Array.isArray(input.decisions)
      ? input.decisions.map((d) => String(d).trim()).filter(Boolean)
      : [];

    let targetAgentId: string | null = input.toAgentId ?? null;
    if (targetAgentId) {
      if (!this.org.getAgent(targetAgentId)) {
        throw new BusError(400, `Target agent not found: ${targetAgentId}`);
      }
    } else if (targetDept.headAgentId) {
      targetAgentId = targetDept.headAgentId;
    } else {
      const deptAgents = this.org.listAgentsInDepartment(targetDept.id);
      targetAgentId = deptAgents[0]?.id ?? null;
    }

    const participants = Array.from(
      new Set([fromAgent.id, ...(targetAgentId ? [targetAgentId] : [])])
    );

    const taskId = `task-${crypto.randomUUID().slice(0, 10)}`;
    const msgSummary = summary.slice(0, BUS_SUMMARY_MAX);
    const bodyText =
      decisions.length > 0
        ? `Tóm tắt: ${summary}\nQuyết định:\n${decisions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
        : summary;
    const cappedBody = bodyText.slice(0, BUS_HANDOFF_BODY_MAX);

    const convRow: BusConversationDbRow = {
      id: `conv-${crypto.randomUUID().slice(0, 10)}`,
      type: "handoff",
      title: `Bàn giao: ${title}`,
      participants_json: JSON.stringify(participants),
      status: "open",
      turn_cap: 12,
      turns: 0,
      created_by: fromAgent.id,
      task_id: taskId,
      summary: msgSummary,
      pause_reason: null,
      opened_at: Date.now(),
      closed_at: null,
    };
    this.db.insertBusConversation(convRow);

    const taskRow: OrgTaskDbRow = {
      id: taskId,
      title,
      kind: "handoff",
      from_agent_id: fromAgent.id,
      department_id: targetDept.id,
      to_agent_id: targetAgentId,
      summary: summary.slice(0, BUS_HANDOFF_BODY_MAX),
      decisions_json: JSON.stringify(decisions),
      status: "handed_off",
      conversation_id: convRow.id,
      created_at: Date.now(),
    };
    this.db.insertOrgTask(taskRow);

    const message = this.deliverMessageToConversation(convRow, {
      fromAgentId: fromAgent.id,
      toAgentId: targetAgentId,
      taskId,
      kind: "handoff",
      summary: msgSummary,
      body: cappedBody,
    });

    const latestConv = this.db.getBusConversation(convRow.id)!;
    return {
      ...this.hydrateTask(taskRow),
      conversation: this.hydrateConversation(latestConv),
      message,
    };
  }

  listTasks(): TaskRecord[] {
    return this.db.listOrgTasks().map((r) => this.hydrateTask(r));
  }
}
