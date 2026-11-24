import {
  CONVERSATION_TYPE_LABEL,
  GROK_BOT_BADGE,
  SLOT_STATUS_COLOR,
  STATUS_COLOR,
  STATUS_LABEL,
  type AccountSlot,
  type Conversation,
  type DepartmentZone,
  type Seat,
} from "../types.ts";

function SeatCardButton({
  seat,
  selected,
  onSelect,
}: {
  seat: Seat;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const isGrokBot = seat.orgKind === "grok_bot" || seat.orgProvider === "grok_external";
  return (
    <button
      type="button"
      className={`seat-card ${seat.status} ${selected ? "selected" : ""}`}
      onClick={() => onSelect(seat.id)}
      style={{ borderColor: STATUS_COLOR[seat.status] }}
    >
      <div className="seat-top">
        <span className="avatar" style={{ background: seat.color, opacity: seat.status === "offline" ? 0.4 : 1 }} />
        <div style={{ minWidth: 0 }}>
          <strong>
            {seat.name}
            {seat.isHead ? " ★" : ""}
          </strong>
          <div className="muted small">{seat.role}</div>
        </div>
      </div>
      <div className="status-line">
        <span className="dot" style={{ background: STATUS_COLOR[seat.status] }} />
        <span>{STATUS_LABEL[seat.status]}</span>
        {seat.isAdmin && <span className="chip ok">Admin</span>}
        {isGrokBot && <span className="chip warn">{GROK_BOT_BADGE}</span>}
      </div>
      {seat.lastEvent && <div className="small last">{seat.lastEvent.summary}</div>}
    </button>
  );
}

export default function SeatGrid2D({
  zones,
  seats,
  selectedId,
  onSelect,
  libraryOpen,
  onOpenLibrary,
  accountsOpen,
  onOpenAccounts,
  meetingOpen,
  onOpenMeeting,
  conversations,
  accountSlots,
}: {
  zones: DepartmentZone[];
  seats: Seat[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  libraryOpen: boolean;
  onOpenLibrary: () => void;
  accountsOpen: boolean;
  onOpenAccounts: () => void;
  meetingOpen: boolean;
  onOpenMeeting: (conversationId?: string) => void;
  conversations: Conversation[];
  accountSlots: AccountSlot[];
}) {
  const readyCount = accountSlots.filter((s) => s.status === "ready").length;
  const openConversations = conversations.filter((c) => c.status === "open");

  return (
    <div className="grid2d-wrap">
      {/* Top facilities: Phòng họp + Thư viện + Tài khoản & Hạn mức */}
      <div className="facilities-grid">
        <div className={`seat-card meeting-card ${meetingOpen ? "selected" : ""}`}>
          <div className="seat-top" onClick={() => onOpenMeeting()} style={{ cursor: "pointer" }}>
            <span className="avatar meeting-avatar">💬</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>Phòng họp</strong>
              <div className="muted small">
                {openConversations.length > 0
                  ? `${openConversations.length} cuộc họp đang mở`
                  : "Không có cuộc họp nào đang mở"}
              </div>
            </div>
            <button type="button" className="btn small ok" onClick={() => onOpenMeeting()}>
              Mở phòng họp
            </button>
          </div>
          {openConversations.length > 0 ? (
            <ul className="meeting-mini-list">
              {openConversations.slice(0, 5).map((conv) => (
                <li key={conv.id}>
                  <button
                    type="button"
                    className="meeting-mini-item"
                    onClick={() => onOpenMeeting(conv.id)}
                  >
                    <span className="chip">{CONVERSATION_TYPE_LABEL[conv.type]}</span>
                    <strong className="meeting-mini-title">{conv.title}</strong>
                    <span className="muted tiny">
                      {conv.turns}/{conv.turnCap} lượt · {conv.participants.length} người
                    </span>
                  </button>
                  {conv.lastMessage && (
                    <div className="muted tiny meeting-mini-summary">{conv.lastMessage.summary}</div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="status-line muted small">
              Bấm “Mở phòng họp” để tạo cuộc họp hoặc xem lịch sử hội thoại.
            </div>
          )}
        </div>

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
            Mở trình xem &amp; đồng bộ
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

      {/* Department zone grouped cards */}
      {zones.length > 0 ? (
        <div className="zones-grid">
          {zones.map((zone) => (
            <section
              key={zone.id}
              className="zone-card"
              style={{ borderTopColor: zone.color }}
            >
              <div className="zone-card-head">
                <div>
                  <h3>{zone.name}</h3>
                  <div className="muted small">
                    {zone.headName ? `Trưởng phòng: ${zone.headName}` : "Chưa có trưởng phòng"}
                  </div>
                </div>
                <span className="count">{zone.seats.length}</span>
              </div>
              {zone.seats.length === 0 ? (
                <div className="muted small">Chưa có thành viên.</div>
              ) : (
                <div className="zone-seats-grid">
                  {zone.seats.map((s) => (
                    <SeatCardButton
                      key={s.id}
                      seat={s}
                      selected={s.id === selectedId}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="grid2d">
          {seats.map((s) => (
            <SeatCardButton
              key={s.id}
              seat={s}
              selected={s.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
