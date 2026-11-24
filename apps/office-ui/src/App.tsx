import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { HUB_HTTP, useHub } from "./hub.ts";
import { buildSeats } from "./seats.ts";
import BudgetMeter from "./components/BudgetMeter.tsx";
import ApprovalQueue from "./components/ApprovalQueue.tsx";
import AgentPanel from "./components/AgentPanel.tsx";
import SeatGrid2D from "./components/SeatGrid2D.tsx";

const Office3D = lazy(() => import("./components/Office3D.tsx"));
const LS_KEY = "agent-office.powerSaver2D";

function usePageHidden() {
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}

export default function App() {
  const hub = useHub();
  const hidden = usePageHidden();
  const [mode2D, setMode2D] = useState(() => localStorage.getItem(LS_KEY) === "1");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => localStorage.setItem(LS_KEY, mode2D ? "1" : "0"), [mode2D]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const seats = useMemo(
    () =>
      buildSeats({
        discovery: hub.discovery,
        events: hub.events,
        approvals: hub.approvals,
        lint: hub.lint,
        connection: hub.connection,
      }),
    [hub.discovery, hub.events, hub.approvals, hub.lint, hub.connection]
  );
  const knownIds = useMemo(() => new Set(seats.map((s) => s.id)), [seats]);
  const selected = seats.find((s) => s.id === selectedId) ?? null;
  const online = hub.connection === "open";

  const doStopAll = async () => {
    setConfirmStop(false);
    try {
      const r = await hub.stopAll();
      setToast(`Đã dừng ${r.stoppedSessions} phiên, từ chối ${r.deniedApprovals} yêu cầu duyệt.`);
    } catch (e) {
      setToast(`Stop All thất bại: ${String(e)}`);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="logo">▣</span> Agent Office
        </div>
        <div className={`conn ${hub.connection}`} title={hub.lastError ?? HUB_HTTP}>
          <span className="dot" />
          {hub.connection === "open" && "Hub đã kết nối"}
          {hub.connection === "connecting" && "Đang kết nối Hub…"}
          {hub.connection === "closed" &&
            `Mất kết nối Hub${hub.retryInSec != null ? ` · thử lại sau ${hub.retryInSec}s` : ""}`}
        </div>
        <BudgetMeter lint={hub.lint} budget={hub.budget} />
        <div className="spacer" />
        <label className="toggle" title="Tắt WebGL để tiết kiệm GPU/RAM">
          <input type="checkbox" checked={mode2D} onChange={(e) => setMode2D(e.target.checked)} />
          <span>Chế độ 2D tiết kiệm</span>
        </label>
        <button className="btn danger strong" disabled={!online} onClick={() => setConfirmStop(true)}>
          ■ Dừng tất cả
        </button>
      </header>

      <main className="main">
        <div className="stage">
          {mode2D ? (
            <SeatGrid2D seats={seats} selectedId={selectedId} onSelect={setSelectedId} />
          ) : (
            <Suspense fallback={<div className="loading">Đang tải văn phòng 3D…</div>}>
              <Office3D seats={seats} selectedId={selectedId} onSelect={setSelectedId} paused={hidden} />
            </Suspense>
          )}
          {!online && (
            <div className="offline-banner">
              Không kết nối được Hub Daemon tại <code>{HUB_HTTP}</code>. Chạy <code>bun run dev:hub</code> ở thư mục gốc
              repo — giao diện sẽ tự kết nối lại.
            </div>
          )}
        </div>
        <aside className="side">
          {selected ? (
            <AgentPanel seat={selected} events={hub.events} knownIds={knownIds} onClose={() => setSelectedId(null)} />
          ) : (
            <section className="card hint">
              <h3>Văn phòng</h3>
              <p className="muted small">
                Bấm vào một bàn để xem tóm tắt và sự kiện gần đây.
                {hub.discovery &&
                  ` Kho ~/.cursor: plugin v${hub.discovery.knowledgeHub.pluginVersion ?? "?"}, ${hub.discovery.knowledgeHub.skillsCount} skill, ${hub.discovery.knowledgeHub.projectKits.length} kit.`}
              </p>
            </section>
          )}
          <ApprovalQueue approvals={hub.approvals} onResolve={hub.resolveApproval} disabled={!online} />
        </aside>
      </main>

      {confirmStop && (
        <div className="modal-backdrop" onClick={() => setConfirmStop(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Dừng tất cả agent?</h3>
            <p className="muted">
              Mọi phiên đang chạy sẽ bị huỷ và toàn bộ yêu cầu đang chờ duyệt sẽ bị từ chối. Thao tác này không hoàn
              tác được.
            </p>
            <div className="row end">
              <button className="btn ghost" onClick={() => setConfirmStop(false)}>
                Huỷ
              </button>
              <button className="btn danger strong" onClick={doStopAll}>
                Dừng ngay
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
