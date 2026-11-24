import { STATUS_COLOR, STATUS_LABEL, type Seat } from "../types.ts";

export default function SeatGrid2D({ seats, selectedId, onSelect }: { seats: Seat[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="grid2d">
      {seats.map((s) => (
        <button
          key={s.id}
          className={`seat-card ${s.status} ${s.id === selectedId ? "selected" : ""}`}
          onClick={() => onSelect(s.id)}
          style={{ borderColor: STATUS_COLOR[s.status] }}
        >
          <div className="seat-top">
            <span className="avatar" style={{ background: s.color, opacity: s.status === "offline" ? 0.4 : 1 }} />
            <div>
              <strong>{s.name}</strong>
              <div className="muted small">{s.role}</div>
            </div>
          </div>
          <div className="status-line">
            <span className="dot" style={{ background: STATUS_COLOR[s.status] }} />
            {STATUS_LABEL[s.status]}
          </div>
          {s.lastEvent && <div className="small last">{s.lastEvent.summary}</div>}
        </button>
      ))}
    </div>
  );
}
