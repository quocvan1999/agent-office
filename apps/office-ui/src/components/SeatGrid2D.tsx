import { SLOT_STATUS_COLOR, STATUS_COLOR, STATUS_LABEL, type AccountSlot, type Seat } from "../types.ts";

export default function SeatGrid2D({
  seats,
  selectedId,
  onSelect,
  libraryOpen,
  onOpenLibrary,
  accountsOpen,
  onOpenAccounts,
  accountSlots,
}: {
  seats: Seat[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  libraryOpen: boolean;
  onOpenLibrary: () => void;
  accountsOpen: boolean;
  onOpenAccounts: () => void;
  accountSlots: AccountSlot[];
}) {
  const readyCount = accountSlots.filter((s) => s.status === "ready").length;
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
      <button
        type="button"
        className={`seat-card library-card ${libraryOpen ? "selected" : ""}`}
        onClick={onOpenLibrary}
      >
        <div className="seat-top">
          <span className="avatar library-avatar">▤</span>
          <div>
            <strong>Thư viện</strong>
            <div className="muted small">Kho tri thức ~/.cursor · rules, kits, skills</div>
          </div>
        </div>
        <div className="status-line">
          <span className="dot" style={{ background: "#d4a373" }} />
          Mở trình xem & đồng bộ
        </div>
      </button>
      <button
        type="button"
        className={`seat-card accounts-card ${accountsOpen ? "selected" : ""}`}
        onClick={onOpenAccounts}
      >
        <div className="seat-top">
          <span className="avatar accounts-avatar">⚡</span>
          <div>
            <strong>Tài khoản &amp; Hạn mức</strong>
            <div className="muted small">
              {accountSlots.length > 0
                ? `${readyCount}/${accountSlots.length} slot sẵn sàng`
                : "Antigravity slots & nhà cung cấp khác"}
            </div>
          </div>
        </div>
        <div className="status-line">
          {accountSlots.length > 0 ? (
            accountSlots.map((slot) => (
              <span
                key={slot.id}
                className="dot"
                title={`${slot.name}: ${slot.status}`}
                style={{ background: SLOT_STATUS_COLOR[slot.status] }}
              />
            ))
          ) : (
            <>
              <span className="dot" style={{ background: "#4f9dff" }} />
              Mở quản lý tài khoản &amp; quota
            </>
          )}
        </div>
      </button>
    </div>
  );
}
