import { useMemo, useState } from "react";
import { HubHttpError, isNotFoundError } from "../hub.ts";
import type { AuditFinding, AuditReport, AuditSeverity } from "../types.ts";

const SEVERITY_RANK: Record<AuditSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const SEVERITY_LABEL: Record<AuditSeverity, string> = {
  critical: "Nghiêm trọng",
  warning: "Cảnh báo",
  info: "Thông tin",
};

export default function AuditPanel({
  report,
  unsupported,
  online,
  onRunAudit,
  compact = false,
}: {
  report: AuditReport | null;
  unsupported: boolean;
  online: boolean;
  onRunAudit: (ai: boolean) => Promise<AuditReport>;
  compact?: boolean;
}) {
  const [runningKind, setRunningKind] = useState<"rule" | "ai" | null>(null);
  const [localUnsupported, setLocalUnsupported] = useState(false);
  const [rateLimitMsg, setRateLimitMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isUnsupported = unsupported || localUnsupported;

  const sortedFindings = useMemo<AuditFinding[]>(() => {
    if (!report) return [];
    return [...report.findings].sort((a, b) => {
      const diff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (diff !== 0) return diff;
      return (b.estSavedTokens ?? 0) - (a.estSavedTokens ?? 0);
    });
  }, [report]);

  const totalEstSaved = useMemo(
    () => sortedFindings.reduce((sum, f) => sum + (f.estSavedTokens ?? 0), 0),
    [sortedFindings]
  );

  const trigger = async (ai: boolean) => {
    setRunningKind(ai ? "ai" : "rule");
    setError(null);
    setRateLimitMsg(null);
    try {
      await onRunAudit(ai);
      setLocalUnsupported(false);
    } catch (e) {
      if (isNotFoundError(e)) {
        setLocalUnsupported(true);
      } else if (e instanceof HubHttpError && e.status === 429) {
        setRateLimitMsg(
          e.serverError
            ? `Bị giới hạn tốc độ (429): ${e.serverError}`
            : "Đang bị giới hạn tốc độ gọi AI (HTTP 429). Vui lòng đợi một lát rồi thử lại."
        );
      } else {
        setError(e instanceof HubHttpError && e.serverError ? e.serverError : String(e));
      }
    } finally {
      setRunningKind(null);
    }
  };

  if (isUnsupported) {
    return (
      <div className="notice-box">
        <strong>Hub chưa hỗ trợ</strong>
        <p className="muted small">
          Endpoint Kiểm toán (<code>/api/audit/*</code>) trả về 404. Hãy cập nhật Hub Daemon lên Giai đoạn 3.
        </p>
      </div>
    );
  }

  return (
    <div className={`audit-panel ${compact ? "compact" : ""}`}>
      <div className="audit-actions">
        <button
          className="btn"
          disabled={!online || runningKind !== null}
          onClick={() => void trigger(false)}
        >
          {runningKind === "rule" ? "Đang kiểm tra…" : "Chạy kiểm tra (0 token)"}
        </button>
        <button
          className="btn ok"
          disabled={!online || runningKind !== null}
          onClick={() => void trigger(true)}
        >
          {runningKind === "ai" ? "Đang hỏi AI…" : "Hỏi AI (agy)"}
        </button>
      </div>

      {rateLimitMsg && <div className="banner warn small">{rateLimitMsg}</div>}
      {error && <div className="banner error-banner small">{error}</div>}

      {!report ? (
        <p className="muted small">
          Chưa có báo cáo kiểm toán nào. Bấm <strong>Chạy kiểm tra (0 token)</strong> để phân tích ngay.
        </p>
      ) : (
        <>
          <div className="audit-totals">
            <div className="stat-box">
              <span className="muted small">Số file</span>
              <strong>{report.totals.files.toLocaleString("vi-VN")}</strong>
            </div>
            <div className="stat-box">
              <span className="muted small">Tổng token</span>
              <strong>{report.totals.tokens.toLocaleString("vi-VN")}</strong>
            </div>
            <div className="stat-box">
              <span className="muted small">Always-on token</span>
              <strong>{report.totals.alwaysLoadedTokens.toLocaleString("vi-VN")}</strong>
            </div>
            {totalEstSaved > 0 && (
              <div className="stat-box saved">
                <span className="muted small">Ước tính tiết kiệm</span>
                <strong>~{totalEstSaved.toLocaleString("vi-VN")} tok</strong>
              </div>
            )}
          </div>

          <div className="muted small audit-meta">
            Loại: <span className="chip">{report.kind === "ai" ? "AI (agy)" : "Quy tắc (0 token)"}</span> · Lúc{" "}
            {new Date(report.at).toLocaleString("vi-VN")}
          </div>

          {report.aiSummary && (
            <div className="audit-section">
              <h4>Nhận xét AI (agy)</h4>
              <pre className="audit-ai-summary">{report.aiSummary}</pre>
            </div>
          )}

          <div className="audit-section">
            <h4>Phát hiện ({sortedFindings.length})</h4>
            {sortedFindings.length === 0 ? (
              <p className="muted small">Không có vấn đề nào được phát hiện.</p>
            ) : (
              <ul className="finding-list">
                {sortedFindings.map((f, idx) => (
                  <li key={`${f.code}-${f.path ?? idx}-${idx}`} className={`finding-item ${f.severity}`}>
                    <div className="finding-head">
                      <span className={`sev-badge ${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
                      <code>{f.code}</code>
                      {f.estSavedTokens != null && f.estSavedTokens > 0 && (
                        <span className="chip ok">tiết kiệm ~{f.estSavedTokens.toLocaleString("vi-VN")} tok</span>
                      )}
                    </div>
                    {f.path && <div className="finding-path small muted">{f.path}</div>}
                    <div className="finding-msg">{f.message}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
