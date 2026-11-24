import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  HubHttpError,
  closeConversation,
  createConversation,
  fetchBusMessages,
  fetchConversationDetail,
  isNotFoundError,
  postBusMessage,
  resumeConversation,
  runConversation,
} from "../hub.ts";
import {
  BUS_KIND_LABEL,
  CONVERSATION_STATUS_LABEL,
  CONVERSATION_TYPE_LABEL,
  type BusMessage,
  type BusMessageKind,
  type Conversation,
  type GuardrailNotice,
  type OrgAgent,
  type OrgResponse,
} from "../types.ts";

function formatError(err: unknown): string {
  if (err instanceof HubHttpError) {
    if (err.serverReason) return err.serverReason;
    if (err.serverError) return err.serverError;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function formatTime(ts: number | string | null | undefined): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColor(id: string): string {
  const palette = ["#4f9dff", "#06d6a0", "#ffd166", "#c77dff", "#ef476f", "#4cc9f0", "#ff9f1c", "#90be6d"];
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function toMs(v: number | string): number {
  if (typeof v === "number") return v;
  const p = Date.parse(v);
  return Number.isNaN(p) ? 0 : p;
}

export default function MeetingRoomPanel({
  org,
  conversations,
  busMessages,
  busRevision,
  lastGuardrail,
  unsupported,
  error,
  online,
  initialConversationId,
  onRefreshConversations,
}: {
  org: OrgResponse | null;
  conversations: Conversation[];
  busMessages: BusMessage[];
  busRevision: number;
  lastGuardrail: GuardrailNotice | null;
  unsupported: boolean;
  error: string | null;
  online: boolean;
  initialConversationId?: string | null;
  onRefreshConversations: () => Promise<void>;
}) {
  const [localUnsupported, setLocalUnsupported] = useState(false);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [selectedId, setSelectedId] = useState<string | null>(initialConversationId ?? null);
  const [showRejected, setShowRejected] = useState(false);

  const [detail, setDetail] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<BusMessage[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Create meeting form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newParticipants, setNewParticipants] = useState<string[]>(["ly-van", "ba-agy-1", "be-agy-1"]);
  const [newTurnCap, setNewTurnCap] = useState("12");

  // Run 1 round (agy) form
  const [runPrompt, setRunPrompt] = useState("");

  // Test send message form (to demo permission rejection)
  const [showTestForm, setShowTestForm] = useState(false);
  const [testFrom, setTestFrom] = useState("ba-agy-1");
  const [testTo, setTestTo] = useState("be-agy-1");
  const [testKind, setTestKind] = useState<BusMessageKind>("request");
  const [testSummary, setTestSummary] = useState("Kiểm tra quyền gửi tin liên phòng ban");
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const agents: OrgAgent[] = org?.agents ?? [];
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const agentName = useCallback(
    (id: string | null | undefined) => {
      if (!id) return "Phòng họp";
      return agentById.get(id)?.name ?? id;
    },
    [agentById]
  );

  // Sync external initialConversationId
  useEffect(() => {
    if (initialConversationId) {
      setSelectedId(initialConversationId);
      const found = conversations.find((c) => c.id === initialConversationId);
      if (found && found.status !== "open") setFilter("all");
    }
  }, [initialConversationId, conversations]);

  // Seed default participants once org loads
  useEffect(() => {
    if (agents.length === 0) return;
    setTestFrom((cur) => (agentById.has(cur) ? cur : agents[0].id));
    setTestTo((cur) => (agentById.has(cur) ? cur : agents[Math.min(1, agents.length - 1)].id));
  }, [agents, agentById]);

  const filteredConversations = useMemo(
    () => (filter === "open" ? conversations.filter((c) => c.status === "open") : conversations),
    [conversations, filter]
  );

  // Auto-select first conversation if current selection disappears
  useEffect(() => {
    if (selectedId && conversations.some((c) => c.id === selectedId)) return;
    if (filteredConversations.length > 0) {
      setSelectedId(filteredConversations[0].id);
    } else if (conversations.length > 0) {
      setSelectedId(conversations[0].id);
    } else {
      setSelectedId(null);
    }
  }, [selectedId, conversations, filteredConversations]);

  const loadSelectedDetail = useCallback(
    async (convId: string, includeRejected: boolean) => {
      setLoadingDetail(true);
      try {
        const [convDetail, busList] = await Promise.all([
          fetchConversationDetail(convId),
          includeRejected
            ? fetchBusMessages({ conversationId: convId, limit: 150, includeRejected: true }).catch(() => null)
            : Promise.resolve(null),
        ]);
        setDetail(convDetail);
        const mergedMap = new Map<string, BusMessage>();
        for (const m of convDetail.messages ?? []) mergedMap.set(m.id, m);
        if (busList) {
          for (const m of busList) mergedMap.set(m.id, m);
        }
        const merged = Array.from(mergedMap.values()).sort((a, b) => toMs(a.ts) - toMs(b.ts));
        setMessages(merged);
        setLocalUnsupported(false);
      } catch (e) {
        if (isNotFoundError(e)) setLocalUnsupported(true);
        else setActionError(formatError(e));
      } finally {
        setLoadingDetail(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!selectedId || unsupported || localUnsupported) {
      setDetail(null);
      setMessages([]);
      return;
    }
    void loadSelectedDetail(selectedId, showRejected);
  }, [selectedId, showRejected, busRevision, unsupported, localUnsupported, loadSelectedDetail]);

  // Merge live WS messages for selected conversation (and rejected global messages when showRejected is on)
  const displayMessages = useMemo(() => {
    const map = new Map<string, BusMessage>();
    for (const m of messages) map.set(m.id, m);
    for (const m of busMessages) {
      const matchesConv = selectedId && m.conversationId === selectedId;
      const isGlobalRejected = showRejected && m.status === "rejected" && !m.conversationId;
      if (matchesConv || isGlobalRejected) {
        if (m.status === "rejected" && !showRejected) continue;
        map.set(m.id, m);
      }
    }
    return Array.from(map.values())
      .filter((m) => showRejected || m.status !== "rejected")
      .sort((a, b) => toMs(a.ts) - toMs(b.ts));
  }, [messages, busMessages, selectedId, showRejected]);

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? detail,
    [conversations, selectedId, detail]
  );

  const toggleParticipant = (id: string) => {
    setNewParticipants((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleCreateMeeting = async (e: FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title || newParticipants.length < 2) {
      setActionError("Cần nhập tiêu đề và chọn ít nhất 2 thành viên.");
      return;
    }
    setBusy("create");
    setActionError(null);
    setActionNotice(null);
    try {
      const cap = Math.max(1, Number.parseInt(newTurnCap, 10) || 12);
      const created = await createConversation({
        type: "meeting",
        title,
        participants: newParticipants,
        turnCap: cap,
      });
      setNewTitle("");
      setShowNewForm(false);
      setFilter("open");
      setSelectedId(created.id);
      setActionNotice(`Đã mở cuộc họp “${created.title}”.`);
      await onRefreshConversations();
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleRunRound = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeConv || !runPrompt.trim()) return;
    setBusy("run");
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await runConversation(activeConv.id, { rounds: 1, prompt: runPrompt.trim() });
      setRunPrompt("");
      setActionNotice(`Đã khởi chạy 1 vòng (agy) · runId: ${res.runId}`);
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleCloseConv = async () => {
    if (!activeConv) return;
    setBusy("close");
    setActionError(null);
    try {
      await closeConversation(activeConv.id);
      await onRefreshConversations();
      await loadSelectedDetail(activeConv.id, showRejected);
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleResumeConv = async () => {
    if (!activeConv) return;
    setBusy("resume");
    setActionError(null);
    try {
      await resumeConversation(activeConv.id);
      await onRefreshConversations();
      await loadSelectedDetail(activeConv.id, showRejected);
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSendTest = async (e: FormEvent) => {
    e.preventDefault();
    if (!testFrom || !testSummary.trim()) return;
    setBusy("test");
    setTestResult(null);
    setActionError(null);
    try {
      const msg = await postBusMessage(
        {
          fromAgentId: testFrom,
          toAgentId: testTo || null,
          conversationId: testKind === "meeting" && activeConv ? activeConv.id : null,
          kind: testKind,
          summary: testSummary.trim(),
        },
        testFrom
      );
      setTestResult({
        ok: true,
        text: `Đã gửi thành công (${msg.status}) · conv: ${msg.conversationId ?? "—"}`,
      });
      await onRefreshConversations();
      if (msg.conversationId) {
        setSelectedId(msg.conversationId);
        await loadSelectedDetail(msg.conversationId, showRejected);
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        setLocalUnsupported(true);
      } else {
        setShowRejected(true);
        setTestResult({
          ok: false,
          text: `Bị chặn (403): ${formatError(err)}`,
        });
      }
    } finally {
      setBusy(null);
    }
  };

  if (unsupported || localUnsupported) {
    return (
      <div className="notice-box">
        <strong>Hub chưa hỗ trợ</strong>
        <p className="muted small">
          Endpoint Phòng họp &amp; Message Bus (<code>/api/conversations</code>, <code>/api/bus/messages</code>) trả về
          404. Hãy cập nhật Hub Daemon.
        </p>
      </div>
    );
  }

  return (
    <div className="meeting-panel">
      {(error || actionError) && (
        <div className="banner error-banner small">
          <span>{actionError ?? error}</span>
          {actionError && (
            <button type="button" className="btn ghost small" onClick={() => setActionError(null)}>
              Đóng
            </button>
          )}
        </div>
      )}
      {actionNotice && (
        <div className="banner ok-banner small">
          <span>{actionNotice}</span>
          <button type="button" className="btn ghost small" onClick={() => setActionNotice(null)}>
            Đóng
          </button>
        </div>
      )}
      {lastGuardrail && (
        <div className="banner warn small">
          <span>
            <strong>Cảnh báo Guardrail</strong> ({lastGuardrail.conversationId || "hệ thống"}): {lastGuardrail.reason}
          </span>
          <span className="tiny muted">{formatTime(lastGuardrail.at)}</span>
        </div>
      )}

      <div className="meeting-layout">
        {/* Left column: conversations + create meeting + test send */}
        <div className="meeting-sidebar">
          <div className="meeting-sidebar-toolbar">
            <div className="tabs">
              <button
                type="button"
                className={`tab ${filter === "open" ? "active" : ""}`}
                onClick={() => setFilter("open")}
              >
                Đang mở ({conversations.filter((c) => c.status === "open").length})
              </button>
              <button
                type="button"
                className={`tab ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                Tất cả ({conversations.length})
              </button>
            </div>
            <button
              type="button"
              className="btn ghost small"
              disabled={!online}
              onClick={() => void onRefreshConversations()}
              title="Làm mới danh sách"
            >
              ↻
            </button>
          </div>

          <div className="row compact">
            <button
              type="button"
              className="btn ok small"
              style={{ flex: 1 }}
              disabled={!online}
              onClick={() => {
                setShowNewForm((v) => !v);
                setShowTestForm(false);
              }}
            >
              {showNewForm ? "Đóng form họp" : "+ Mở cuộc họp"}
            </button>
            <button
              type="button"
              className="btn small"
              disabled={!online}
              onClick={() => {
                setShowTestForm((v) => !v);
                setShowNewForm(false);
              }}
            >
              {showTestForm ? "Đóng gửi thử" : "Gửi tin thử"}
            </button>
          </div>

          {showNewForm && (
            <form className="subform-box" onSubmit={(e) => void handleCreateMeeting(e)}>
              <div className="small">
                <strong>Mở cuộc họp mới</strong>
              </div>
              <input
                type="text"
                className="input small-input"
                placeholder="Tiêu đề cuộc họp…"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                required
              />
              <label className="field">
                <span className="muted tiny">Giới hạn lượt (turn cap)</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  className="input small-input"
                  value={newTurnCap}
                  onChange={(e) => setNewTurnCap(e.target.value)}
                />
              </label>
              <div className="field">
                <span className="muted tiny">Thành viên tham gia ({newParticipants.length})</span>
                <div className="participant-picker">
                  {agents.map((a) => (
                    <label key={a.id} className="picker-chip">
                      <input
                        type="checkbox"
                        checked={newParticipants.includes(a.id)}
                        onChange={() => toggleParticipant(a.id)}
                      />
                      <span>{a.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <button
                type="submit"
                className="btn ok small"
                disabled={!online || busy === "create" || !newTitle.trim() || newParticipants.length < 2}
              >
                {busy === "create" ? "Đang tạo…" : "Tạo cuộc họp"}
              </button>
            </form>
          )}

          {showTestForm && (
            <form className="subform-box" onSubmit={(e) => void handleSendTest(e)}>
              <div className="small">
                <strong>Gửi tin thử (kiểm tra phân quyền)</strong>
              </div>
              <div className="two-col">
                <label className="field">
                  <span className="muted tiny">Từ (from)</span>
                  <select
                    className="input small-input"
                    value={testFrom}
                    onChange={(e) => setTestFrom(e.target.value)}
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="muted tiny">Đến (to)</span>
                  <select
                    className="input small-input"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                  >
                    <option value="">— Không chỉ định —</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span className="muted tiny">Loại tin (kind)</span>
                <select
                  className="input small-input"
                  value={testKind}
                  onChange={(e) => setTestKind(e.target.value as BusMessageKind)}
                >
                  <option value="request">request (Yêu cầu)</option>
                  <option value="reply">reply (Phản hồi)</option>
                  <option value="meeting">meeting (Họp)</option>
                  <option value="handoff">handoff (Bàn giao)</option>
                </select>
              </label>
              <input
                type="text"
                className="input small-input"
                placeholder="Tóm tắt nội dung…"
                value={testSummary}
                onChange={(e) => setTestSummary(e.target.value)}
                required
              />
              <button
                type="submit"
                className="btn small"
                disabled={!online || busy === "test" || !testSummary.trim()}
              >
                {busy === "test" ? "Đang gửi…" : "Gửi tin thử"}
              </button>
              {testResult && (
                <div className={`banner small ${testResult.ok ? "ok-banner" : "error-banner"}`}>
                  {testResult.text}
                </div>
              )}
            </form>
          )}

          <div className="conv-list">
            {filteredConversations.length === 0 ? (
              <div className="muted small" style={{ padding: 8 }}>
                {filter === "open" ? "Chưa có cuộc họp nào đang mở." : "Chưa có hội thoại nào."}
              </div>
            ) : (
              filteredConversations.map((conv) => {
                const isSelected = conv.id === selectedId;
                const statusChipClass =
                  conv.status === "open" ? "ok" : conv.status === "paused" ? "warn" : "";
                return (
                  <button
                    key={conv.id}
                    type="button"
                    className={`conv-item ${isSelected ? "active" : ""}`}
                    onClick={() => setSelectedId(conv.id)}
                  >
                    <div className="conv-item-top">
                      <span className={`chip conv-type-${conv.type}`}>
                        {CONVERSATION_TYPE_LABEL[conv.type]}
                      </span>
                      <span className={`chip ${statusChipClass}`}>
                        {CONVERSATION_STATUS_LABEL[conv.status]}
                      </span>
                      <span className="muted tiny" style={{ marginLeft: "auto" }}>
                        {conv.turns}/{conv.turnCap} lượt
                      </span>
                    </div>
                    <strong className="conv-item-title">{conv.title}</strong>
                    <div className="conv-avatars">
                      {conv.participants.slice(0, 6).map((pid) => {
                        const name = agentName(pid);
                        return (
                          <span
                            key={pid}
                            className="mini-avatar"
                            style={{ background: avatarColor(pid) }}
                            title={name}
                          >
                            {initials(name)}
                          </span>
                        );
                      })}
                      {conv.participants.length > 6 && (
                        <span className="muted tiny">+{conv.participants.length - 6}</span>
                      )}
                    </div>
                    {conv.status === "paused" && conv.pauseReason && (
                      <div className="tiny conv-pause-reason">Tạm dừng: {conv.pauseReason}</div>
                    )}
                    {conv.lastMessage && (
                      <div className="muted tiny conv-item-last">{conv.lastMessage.summary}</div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right column: live transcript + actions */}
        <div className="meeting-transcript">
          {!activeConv ? (
            <div className="library-empty muted small">
              Chọn một cuộc họp bên trái hoặc bấm “+ Mở cuộc họp” để bắt đầu.
            </div>
          ) : (
            <>
              <div className="transcript-head">
                <div style={{ minWidth: 0 }}>
                  <div className="row compact" style={{ flexWrap: "wrap" }}>
                    <span className={`chip conv-type-${activeConv.type}`}>
                      {CONVERSATION_TYPE_LABEL[activeConv.type]}
                    </span>
                    <span
                      className={`chip ${
                        activeConv.status === "open"
                          ? "ok"
                          : activeConv.status === "paused"
                            ? "warn"
                            : ""
                      }`}
                    >
                      {CONVERSATION_STATUS_LABEL[activeConv.status]}
                    </span>
                    <span className="chip">
                      {activeConv.turns}/{activeConv.turnCap} lượt
                    </span>
                  </div>
                  <h3 style={{ margin: "6px 0 4px" }}>{activeConv.title}</h3>
                  <div className="muted tiny">
                    Thành viên: {activeConv.participants.map((p) => agentName(p)).join(", ")}
                  </div>
                  {activeConv.status === "paused" && activeConv.pauseReason && (
                    <div className="banner warn small" style={{ marginTop: 6 }}>
                      Lý do tạm dừng: {activeConv.pauseReason}
                    </div>
                  )}
                  {activeConv.summary && (
                    <div className="muted small" style={{ marginTop: 6 }}>
                      <strong>Tóm tắt:</strong> {activeConv.summary}
                    </div>
                  )}
                </div>

                <div className="row compact" style={{ flexWrap: "wrap" }}>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={showRejected}
                      onChange={(e) => setShowRejected(e.target.checked)}
                    />
                    <span>Hiện tin bị chặn</span>
                  </label>
                  {activeConv.status !== "closed" ? (
                    <button
                      type="button"
                      className="btn danger small"
                      disabled={!online || busy !== null}
                      onClick={() => void handleCloseConv()}
                    >
                      {busy === "close" ? "Đang đóng…" : "Đóng cuộc họp"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn ok small"
                      disabled={!online || busy !== null}
                      onClick={() => void handleResumeConv()}
                    >
                      {busy === "resume" ? "Đang mở…" : "Mở lại"}
                    </button>
                  )}
                  {activeConv.status === "paused" && (
                    <button
                      type="button"
                      className="btn ok small"
                      disabled={!online || busy !== null}
                      onClick={() => void handleResumeConv()}
                    >
                      {busy === "resume" ? "Đang mở…" : "Tiếp tục"}
                    </button>
                  )}
                </div>
              </div>

              {activeConv.status === "open" && (
                <form className="run-round-bar" onSubmit={(e) => void handleRunRound(e)}>
                  <input
                    type="text"
                    className="input small-input"
                    placeholder="Nhập chủ đề / câu hỏi cho 1 vòng thảo luận (agy)…"
                    value={runPrompt}
                    disabled={!online || busy === "run"}
                    onChange={(e) => setRunPrompt(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn ok small"
                    disabled={!online || busy === "run" || !runPrompt.trim()}
                  >
                    {busy === "run" ? "Đang chạy…" : "▶ Chạy 1 vòng (agy)"}
                  </button>
                </form>
              )}

              <div className="transcript-messages">
                {loadingDetail && displayMessages.length === 0 ? (
                  <div className="muted small">Đang tải nội dung hội thoại…</div>
                ) : displayMessages.length === 0 ? (
                  <div className="muted small">Chưa có tin nhắn nào trong cuộc họp này.</div>
                ) : (
                  displayMessages.map((msg) => {
                    const rejected = msg.status === "rejected";
                    return (
                      <article
                        key={msg.id}
                        className={`transcript-msg ${rejected ? "rejected" : ""}`}
                      >
                        <div className="transcript-msg-head">
                          <strong>{agentName(msg.fromAgentId)}</strong>
                          <span className="muted">→</span>
                          <strong>{agentName(msg.toAgentId)}</strong>
                          <span className="chip">{BUS_KIND_LABEL[msg.kind]}</span>
                          {rejected && <span className="chip block">Bị chặn</span>}
                          <span className="chip">~{msg.tokenEstimate} tok</span>
                          <span className="muted tiny" style={{ marginLeft: "auto" }}>
                            {formatTime(msg.ts)}
                          </span>
                        </div>
                        <div className="transcript-msg-summary">
                          <strong>{msg.summary}</strong>
                        </div>
                        {rejected && msg.rejectReason && (
                          <div className="transcript-reject-reason small">
                            Lý do chặn: {msg.rejectReason}
                          </div>
                        )}
                        {msg.body && (
                          <details className="transcript-msg-body">
                            <summary className="muted tiny">Xem chi tiết nội dung</summary>
                            <pre>{msg.body}</pre>
                          </details>
                        )}
                      </article>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
