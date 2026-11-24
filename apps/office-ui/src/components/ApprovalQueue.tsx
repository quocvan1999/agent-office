import { useState } from "react";
import type { PendingApproval } from "../types.ts";

export default function ApprovalQueue({
  approvals,
  onResolve,
  disabled,
}: {
  approvals: PendingApproval[];
  onResolve: (id: string, approved: boolean) => Promise<void>;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (id: string, approved: boolean) => {
    setBusy(id);
    setErr(null);
    try {
      await onResolve(id, approved);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className={`card approvals ${approvals.length ? "has-pending" : ""}`}>
      <h3>
        Hàng đợi duyệt <span className="count">{approvals.length}</span>
      </h3>
      {approvals.length === 0 && <p className="muted">Không có yêu cầu nào đang chờ.</p>}
      {approvals.map((a) => (
        <div key={a.id} className="approval">
          <div className="approval-head">
            <strong>{a.action}</strong>
            <span className="muted">{new Date(a.createdAt).toLocaleTimeString("vi-VN")}</span>
          </div>
          <div className="muted small">
            {a.agentId} · task {a.taskId}
          </div>
          {a.detail && <pre className="detail">{a.detail}</pre>}
          <div className="row">
            <button className="btn ok" disabled={disabled || busy === a.id} onClick={() => act(a.id, true)}>
              Duyệt
            </button>
            <button className="btn danger" disabled={disabled || busy === a.id} onClick={() => act(a.id, false)}>
              Từ chối
            </button>
          </div>
        </div>
      ))}
      {err && <p className="error small">{err}</p>}
    </section>
  );
}
