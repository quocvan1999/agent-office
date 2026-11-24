import { STATUS_COLOR, STATUS_LABEL, type AgentEvent, type Seat } from "../types.ts";

export default function AgentPanel({
  seat,
  events,
  knownIds,
  onClose,
}: {
  seat: Seat;
  events: AgentEvent[];
  knownIds: Set<string>;
  onClose: () => void;
}) {
  const mine = events
    .filter((e) => e.agentId === seat.id || (!knownIds.has(e.agentId) && e.provider === seat.provider))
    .slice(0, 20);
  const tel = seat.lastEvent?.telemetry;
  return (
    <section className="card panel">
      <div className="panel-head">
        <div>
          <h3>{seat.name}</h3>
          <div className="muted small">{seat.role}</div>
        </div>
        <button className="btn ghost" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </div>
      <div className="status-line">
        <span className="dot" style={{ background: STATUS_COLOR[seat.status] }} />
        {STATUS_LABEL[seat.status]}
        {seat.provider && <span className="chip">{seat.provider}</span>}
        <span className={`chip ${seat.ready ? "ok" : "warn"}`}>{seat.ready ? "sẵn sàng" : "chưa sẵn sàng"}</span>
      </div>
      {seat.reason && <p className="muted small">{seat.reason}</p>}
      {seat.lastEvent && (
        <div className="summary">
          <div className="small muted">Tóm tắt gần nhất</div>
          <p>{seat.lastEvent.summary}</p>
          {tel && (
            <div className="small muted">
              tool calls {tel.toolCallCount} · lặp {tel.repeatedActionCount}
              {tel.inputTokens != null && ` · in ${tel.inputTokens}`}
              {tel.outputTokens != null && ` · out ${tel.outputTokens}`}
            </div>
          )}
        </div>
      )}
      <h4>Sự kiện gần đây</h4>
      {mine.length === 0 && <p className="muted small">Chưa có sự kiện nào cho bàn này.</p>}
      <ul className="events">
        {mine.map((e) => (
          <li key={e.id}>
            <span className="dot" style={{ background: STATUS_COLOR[e.status] }} />
            <span className="muted small">{new Date(e.ts).toLocaleTimeString("vi-VN")}</span>
            <span>{e.summary}</span>
            {e.toolName && <code>{e.toolName}</code>}
          </li>
        ))}
      </ul>
    </section>
  );
}
