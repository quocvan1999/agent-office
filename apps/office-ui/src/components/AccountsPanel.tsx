import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  HubHttpError,
  cancelSlotSignIn,
  checkAccountSlot,
  createAccountSlot,
  deleteAccountSlot,
  fetchSlotSignIn,
  isNotFoundError,
  patchAccountProvider,
  patchAccountSlot,
  signInAccountSlot,
  startSlotSignIn,
  submitSlotSignInCode,
  useClock,
} from "../hub.ts";
import {
  SIGNIN_STATE_COLOR,
  SIGNIN_STATE_LABEL,
  SLOT_EFFORTS,
  SLOT_STATUS_COLOR,
  SLOT_STATUS_LABEL,
  SOURCE_LABEL,
  type AccountSlot,
  type AccountsResponse,
  type PatchProviderRequest,
  type ProviderRow,
  type SignInSession,
  type SlotEffort,
} from "../types.ts";

function formatError(err: unknown): string {
  if (err instanceof HubHttpError) return err.serverError || err.message;
  return err instanceof Error ? err.message : String(err);
}

function formatCountdown(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;
  const diffSec = Math.floor((target - nowMs) / 1000);
  if (diffSec <= 0) return "đã đến hạn";
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  if (days > 0) return `${days} ngày ${hours}g ${mins}p`;
  if (hours > 0) return `${hours}g ${mins}p`;
  if (mins > 0) return `${mins}p ${secs}s`;
  return `${secs}s`;
}

function formatUtc7(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const formatted = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
  return `${formatted} (UTC+7)`;
}

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Format in local browser time for datetime-local input
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function suggestNextSlotName(slots: AccountSlot[]): string {
  const taken = new Set<string>();
  for (const s of slots) {
    taken.add(s.name.trim().toLowerCase());
    taken.add(s.id.trim().toLowerCase());
  }
  let n = 2;
  while (taken.has(`acc${n}`)) n += 1;
  return `acc${n}`;
}

function SlotCard({
  slot,
  signInSession,
  quotaLowPct,
  nowMs,
  online,
  onMutated,
  onSignInSession,
  onToast,
  onUnsupported,
  onError,
}: {
  slot: AccountSlot;
  signInSession: SignInSession | null;
  quotaLowPct: number;
  nowMs: number;
  online: boolean;
  onMutated: () => Promise<void>;
  onSignInSession: (session: SignInSession) => void;
  onToast: (msg: string) => void;
  onUnsupported: () => void;
  onError: (msg: string | null) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(slot.name);
  const [busy, setBusy] = useState<string | null>(null);

  const [limitNote, setLimitNote] = useState(slot.manual?.limitNote ?? "");
  const [resetRule, setResetRule] = useState(slot.manual?.resetRule ?? "");

  const [signInCmd, setSignInCmd] = useState(slot.signInCommand);
  const [signInStatus, setSignInStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [purgeDir, setPurgeDir] = useState(false);
  const lastCompletedRef = useRef<string | null>(null);

  useEffect(() => {
    setDraftName(slot.name);
  }, [slot.name]);

  useEffect(() => {
    setLimitNote(slot.manual?.limitNote ?? "");
    setResetRule(slot.manual?.resetRule ?? "");
  }, [slot.manual?.limitNote, slot.manual?.resetRule]);

  useEffect(() => {
    setSignInCmd(slot.signInCommand);
  }, [slot.signInCommand]);

  // Restore any active web sign-in session from Hub on mount
  useEffect(() => {
    if (!online || slot.isDefault) return;
    if (slot.status !== "signed_out" && slot.status !== "unknown") return;
    let cancelled = false;
    fetchSlotSignIn(slot.id)
      .then((session) => {
        if (!cancelled && session) onSignInSession(session);
      })
      .catch(() => {
        // ignore if hub does not yet support or offline
      });
    return () => {
      cancelled = true;
    };
  }, [online, slot.id, slot.isDefault, slot.status, onSignInSession]);

  // Notify once on sign-in completion & refresh slot info
  useEffect(() => {
    if (signInSession?.state !== "completed") return;
    const key = `${signInSession.startedAt}:${signInSession.updatedAt}`;
    if (lastCompletedRef.current === key) return;
    lastCompletedRef.current = key;
    setAuthCode("");
    setCodeError(null);
    onToast(`Đăng nhập Google thành công cho slot “${slot.name}”.`);
    void onMutated();
  }, [signInSession?.state, signInSession?.startedAt, signInSession?.updatedAt, slot.name, onToast, onMutated]);

  const manualDirty =
    limitNote !== (slot.manual?.limitNote ?? "") || resetRule !== (slot.manual?.resetRule ?? "");

  const runAction = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag);
    onError(null);
    try {
      await fn();
      await onMutated();
    } catch (e) {
      if (isNotFoundError(e)) onUnsupported();
      else onError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleRenameSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === slot.name) {
      setRenaming(false);
      setDraftName(slot.name);
      return;
    }
    await runAction("rename", async () => {
      await patchAccountSlot(slot.id, { name: trimmed });
      setRenaming(false);
    });
  };

  const handleStartGoogleSignIn = async () => {
    setBusy("signin_start");
    setCodeError(null);
    setAuthCode("");
    onError(null);
    try {
      const session = await startSlotSignIn(slot.id);
      onSignInSession(session);
    } catch (e) {
      if (isNotFoundError(e)) onUnsupported();
      else onError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleSubmitCode = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = authCode.trim();
    if (!trimmed) {
      setCodeError("Vui lòng dán mã xác thực.");
      return;
    }
    if (trimmed.length < 10 || trimmed.length > 2048 || /\s/.test(trimmed)) {
      setCodeError("Mã xác thực không hợp lệ (10–2048 ký tự, không chứa khoảng trắng).");
      return;
    }
    setBusy("signin_code");
    setCodeError(null);
    onError(null);
    try {
      const session = await submitSlotSignInCode(slot.id, trimmed);
      onSignInSession(session);
    } catch (e) {
      if (isNotFoundError(e)) onUnsupported();
      else setCodeError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleCancelGoogleSignIn = async () => {
    setBusy("signin_cancel");
    setCodeError(null);
    onError(null);
    try {
      const session = await cancelSlotSignIn(slot.id);
      onSignInSession(session);
    } catch (e) {
      if (isNotFoundError(e)) onUnsupported();
      else onError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleOpenTerminal = async () => {
    setBusy("terminal");
    setSignInStatus(null);
    onError(null);
    try {
      const res = await signInAccountSlot(slot.id, true);
      setSignInCmd(res.command || slot.signInCommand);
      setSignInStatus(
        res.opened
          ? "Đã mở Terminal với lệnh đăng nhập."
          : "Không tự mở được Terminal — hãy sao chép lệnh và chạy thủ công."
      );
    } catch (e) {
      if (isNotFoundError(e)) onUnsupported();
      else onError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleCopyCmd = async () => {
    try {
      await navigator.clipboard.writeText(signInCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setSignInStatus("Không sao chép được vào clipboard — hãy bôi đen lệnh để copy.");
    }
  };

  const cooldownLeft = slot.status === "cooldown" ? formatCountdown(slot.cooldownUntil, nowMs) : null;
  const statusColor = SLOT_STATUS_COLOR[slot.status];
  const needsGoogleSignIn = !slot.isDefault && (slot.status === "signed_out" || slot.status === "unknown");
  const isSignInActive =
    signInSession != null &&
    (signInSession.state === "starting" ||
      signInSession.state === "awaiting_user" ||
      signInSession.state === "verifying");
  const showWebSignInBox =
    isSignInActive ||
    (needsGoogleSignIn &&
      signInSession != null &&
      (signInSession.state === "failed" ||
        signInSession.state === "timeout" ||
        signInSession.state === "cancelled"));
  const signInExpiresLeft =
    isSignInActive && signInSession ? formatCountdown(signInSession.expiresAt, nowMs) : null;

  return (
    <article className={`slot-card status-${slot.status} ${slot.enabled ? "" : "slot-disabled"}`}>
      <div className="slot-head">
        <div className="slot-title-block">
          {renaming ? (
            <form className="slot-rename-form" onSubmit={(e) => void handleRenameSubmit(e)}>
              <input
                type="text"
                className="input small-input"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setRenaming(false);
                    setDraftName(slot.name);
                  }
                }}
                autoFocus
                disabled={busy !== null}
              />
              <button type="submit" className="btn ok small" disabled={busy !== null || !draftName.trim()}>
                Lưu
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  setRenaming(false);
                  setDraftName(slot.name);
                }}
              >
                Huỷ
              </button>
            </form>
          ) : (
            <div className="slot-name-row">
              <button
                type="button"
                className="slot-name-btn"
                title="Bấm để đổi tên slot"
                disabled={!online || busy !== null}
                onClick={() => setRenaming(true)}
              >
                <strong>{slot.name}</strong>
                <span className="muted small">✎</span>
              </button>
              {slot.isDefault && <span className="chip">Mặc định</span>}
            </div>
          )}
          <div className="muted small slot-email" title={slot.homeDir}>
            Email: {slot.email ? <span>{slot.email}</span> : "—"}
          </div>
        </div>

        <div className="slot-head-right">
          <span className={`slot-status-badge status-${slot.status}`} style={{ borderColor: statusColor }}>
            <span className="dot" style={{ background: statusColor }} />
            <span>
              {SLOT_STATUS_LABEL[slot.status]}
              {cooldownLeft ? ` · ${cooldownLeft}` : ""}
            </span>
          </span>
          <label className="toggle" title="Bật/tắt sử dụng slot này">
            <input
              type="checkbox"
              checked={slot.enabled}
              disabled={!online || busy !== null}
              onChange={(e) =>
                void runAction("toggle", async () => {
                  await patchAccountSlot(slot.id, { enabled: e.target.checked });
                })
              }
            />
            <span>{slot.enabled ? "Đang bật" : "Đã tắt"}</span>
          </label>
        </div>
      </div>

      <div className="slot-controls">
        <label className="field">
          <span className="muted small">Model</span>
          <select
            className="input small-input"
            value={slot.model ?? ""}
            disabled={!online || busy !== null || slot.models.length === 0}
            onChange={(e) =>
              void runAction("model", async () => {
                await patchAccountSlot(slot.id, { model: e.target.value || null });
              })
            }
          >
            {slot.models.length === 0 ? (
              <option value="">— Chưa có danh sách model —</option>
            ) : (
              <>
                {!slot.model && <option value="">— Chọn model —</option>}
                {slot.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.id})
                  </option>
                ))}
              </>
            )}
          </select>
          {slot.models.length === 0 && (
            <span className="muted tiny">Danh sách trống — đăng nhập rồi bấm “Kiểm tra” để tải model.</span>
          )}
        </label>

        <label className="field">
          <span className="muted small">Effort</span>
          <select
            className="input small-input"
            value={slot.effort}
            disabled={!online || busy !== null}
            onChange={(e) =>
              void runAction("effort", async () => {
                await patchAccountSlot(slot.id, { effort: e.target.value as SlotEffort });
              })
            }
          >
            {SLOT_EFFORTS.map((ef) => (
              <option key={ef} value={ef}>
                {ef}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span className="muted small">Credits còn lại</span>
          <div className="slot-credits">
            <strong>{slot.credits != null ? slot.credits.toLocaleString("vi-VN") : "—"}</strong>
          </div>
        </div>
      </div>

      <div className="slot-section">
        <div className="slot-section-head">
          <span className="muted small">Hạn mức theo cửa sổ</span>
          {slot.lastCheckedAt && (
            <span className="muted tiny">Kiểm tra: {formatUtc7(slot.lastCheckedAt)}</span>
          )}
        </div>
        {slot.quota.length === 0 ? (
          <div className="muted small">—</div>
        ) : (
          <div className="quota-list">
            {slot.quota.map((q, idx) => {
              const pct = clampPct(q.remainingPct);
              const cd = formatCountdown(q.resetAt, nowMs);
              const barLevel = pct <= 5 ? "block" : pct <= quotaLowPct ? "warn" : "ok";
              return (
                <div key={`${q.group}-${q.window}-${idx}`} className="quota-item">
                  <div className="quota-item-top">
                    <span>
                      <strong>{q.group}</strong> · {q.window}
                    </span>
                    <div className="row compact">
                      <strong className={`quota-pct ${barLevel}`}>{q.remainingPct}% còn lại</strong>
                      <span className="chip">{SOURCE_LABEL[q.source]}</span>
                    </div>
                  </div>
                  <div className="quota-bar">
                    <div className={`quota-fill ${barLevel}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="quota-meta muted tiny">
                    <span>{cd ? `đặt lại sau ${cd}` : "—"}</span>
                    <span>{formatUtc7(q.resetAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="slot-section measured-box">
        <div className="slot-section-head">
          <span className="muted small">Thống kê sử dụng</span>
          <span className="chip">{SOURCE_LABEL[slot.measured.source]}</span>
        </div>
        <div className="measured-grid">
          <div>
            <span className="muted tiny">Số lượt</span>
            <strong>{slot.measured.requests.toLocaleString("vi-VN")}</strong>
          </div>
          <div>
            <span className="muted tiny">Tổng token</span>
            <strong>{slot.measured.totalTokens.toLocaleString("vi-VN")}</strong>
          </div>
          <div>
            <span className="muted tiny">Lần chạy cuối</span>
            <strong>{slot.measured.lastJobAt ? formatUtc7(slot.measured.lastJobAt) : "—"}</strong>
          </div>
        </div>
      </div>

      {slot.lastQuotaError && (
        <div className="banner error-banner small">
          <div>
            <strong>Lỗi hạn mức gần nhất:</strong> {slot.lastQuotaError.message}
          </div>
          <span className="tiny">{formatUtc7(slot.lastQuotaError.at)}</span>
        </div>
      )}

      <div className="slot-section manual-box">
        <div className="slot-section-head">
          <span className="muted small">Ghi chú bổ sung</span>
          <span className="chip">{SOURCE_LABEL.manual}</span>
        </div>
        <div className="manual-grid">
          <input
            type="text"
            className="input small-input"
            placeholder="Ghi chú hạn mức (limitNote)…"
            value={limitNote}
            disabled={!online || busy !== null}
            onChange={(e) => setLimitNote(e.target.value)}
          />
          <input
            type="text"
            className="input small-input"
            placeholder="Quy tắc đặt lại (resetRule)…"
            value={resetRule}
            disabled={!online || busy !== null}
            onChange={(e) => setResetRule(e.target.value)}
          />
          <button
            type="button"
            className="btn small ok"
            disabled={!online || busy !== null || !manualDirty}
            onClick={() =>
              void runAction("manual", async () => {
                await patchAccountSlot(slot.id, {
                  manual: {
                    limitNote: limitNote.trim() || undefined,
                    resetRule: resetRule.trim() || undefined,
                  },
                });
              })
            }
          >
            {busy === "manual" ? "Đang lưu…" : "Lưu"}
          </button>
        </div>
      </div>

      {showWebSignInBox && signInSession && (
        <div className="signin-box web-signin-box">
          <div className="web-signin-head">
            <span
              className="slot-status-badge"
              style={{ borderColor: SIGNIN_STATE_COLOR[signInSession.state] }}
            >
              <span className="dot" style={{ background: SIGNIN_STATE_COLOR[signInSession.state] }} />
              <span>{SIGNIN_STATE_LABEL[signInSession.state]}</span>
            </span>
            {signInExpiresLeft && (
              <span className="muted tiny">Hết hạn sau {signInExpiresLeft}</span>
            )}
          </div>

          {signInSession.state === "starting" && (
            <div className="muted small">Đang khởi tạo phiên đăng nhập Google cho slot này…</div>
          )}

          {(signInSession.state === "awaiting_user" || signInSession.state === "verifying") && (
            <>
              <div className="muted small">
                Đăng nhập tài khoản Google cho slot này. Nếu trang hiện mã xác thực, dán vào ô dưới
              </div>
              {signInSession.authUrl && (
                <div className="row compact" style={{ flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() =>
                      window.open(signInSession.authUrl, "_blank", "noopener,noreferrer")
                    }
                  >
                    Mở trang đăng nhập Google
                  </button>
                  <a
                    href={signInSession.authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="signin-fallback-link small"
                  >
                    Mở liên kết trực tiếp ↗
                  </a>
                </div>
              )}
              <form className="web-signin-code-form" onSubmit={(e) => void handleSubmitCode(e)}>
                <input
                  type="text"
                  className="input small-input"
                  placeholder="Dán mã xác thực Google tại đây…"
                  value={authCode}
                  disabled={!online || busy !== null || signInSession.state === "verifying"}
                  onChange={(e) => {
                    setAuthCode(e.target.value);
                    if (codeError) setCodeError(null);
                  }}
                />
                <button
                  type="submit"
                  className="btn small ok"
                  disabled={!online || busy !== null || signInSession.state === "verifying"}
                >
                  {busy === "signin_code" || signInSession.state === "verifying"
                    ? "Đang xác nhận…"
                    : "Xác nhận"}
                </button>
              </form>
              {codeError && <div className="inline-validation">{codeError}</div>}
            </>
          )}

          {(signInSession.state === "failed" || signInSession.state === "timeout") &&
            signInSession.message && (
              <pre className="signin-cmd signin-error-log">{signInSession.message}</pre>
            )}

          {isSignInActive && (
            <div className="row compact">
              <button
                type="button"
                className="btn ghost small danger"
                disabled={!online || busy !== null}
                onClick={() => void handleCancelGoogleSignIn()}
              >
                {busy === "signin_cancel" ? "Đang hủy…" : "Hủy"}
              </button>
            </div>
          )}
        </div>
      )}

      <details className="manual-signin-details">
        <summary className="muted small">Cách thủ công</summary>
        <div className="signin-box" style={{ marginTop: 6 }}>
          <div className="muted small">Chạy lệnh này trong Terminal rồi đăng nhập Google:</div>
          <pre className="signin-cmd">{signInCmd || "—"}</pre>
          <div className="row compact">
            <button type="button" className="btn small" onClick={() => void handleCopyCmd()} disabled={!signInCmd}>
              {copied ? "Đã sao chép" : "Sao chép"}
            </button>
            <button
              type="button"
              className="btn small ok"
              disabled={!online || busy !== null}
              onClick={() => void handleOpenTerminal()}
            >
              {busy === "terminal" ? "Đang mở…" : "Mở Terminal"}
            </button>
          </div>
          {signInStatus && <div className="muted tiny">{signInStatus}</div>}
        </div>
      </details>

      <div className="slot-actions">
        {needsGoogleSignIn && (
          <button
            type="button"
            className="btn small primary"
            disabled={!online || busy !== null || isSignInActive}
            onClick={() => void handleStartGoogleSignIn()}
          >
            {busy === "signin_start" ? "Đang mở…" : "Đăng nhập Google"}
          </button>
        )}
        <button
          type="button"
          className="btn small ok"
          disabled={!online || busy !== null}
          onClick={() =>
            void runAction("check", async () => {
              await checkAccountSlot(slot.id);
            })
          }
        >
          {busy === "check" ? "Đang kiểm tra…" : "Kiểm tra"}
        </button>
        <div className="spacer" />
        <button
          type="button"
          className="btn small danger"
          disabled={!online || busy !== null || slot.isDefault}
          title={slot.isDefault ? "Không thể xóa slot mặc định" : "Xóa slot này"}
          onClick={() => {
            setPurgeDir(false);
            setConfirmDelete(true);
          }}
        >
          Xóa
        </button>
      </div>

      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Xóa slot “{slot.name}”?</h3>
            <p className="muted small">
              Thư mục hồ sơ: <code>{slot.homeDir}</code>
            </p>
            <label className="toggle" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={purgeDir} onChange={(e) => setPurgeDir(e.target.checked)} />
              <span>Xóa cả thư mục hồ sơ</span>
            </label>
            <div className="row end">
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>
                Huỷ
              </button>
              <button
                type="button"
                className="btn danger strong"
                disabled={busy !== null}
                onClick={() =>
                  void runAction("delete", async () => {
                    await deleteAccountSlot(slot.id, purgeDir);
                    setConfirmDelete(false);
                  })
                }
              >
                {busy === "delete" ? "Đang xóa…" : "Xác nhận xóa"}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

interface ProviderEditDraft {
  usedPct: string;
  sharePct: string;
  resetAt: string;
  resetRule: string;
  limitNote: string;
  note: string;
}

function toProviderDraft(row: ProviderRow): ProviderEditDraft {
  return {
    usedPct: row.usedPct != null ? String(row.usedPct) : "",
    sharePct: row.sharePct != null ? String(row.sharePct) : "",
    resetAt: isoToLocalInput(row.resetAt),
    resetRule: row.resetRule ?? "",
    limitNote: row.limitNote ?? "",
    note: row.note ?? "",
  };
}

export default function AccountsPanel({
  accounts,
  signInSessions,
  unsupported,
  error,
  online,
  onRefresh,
  onSignInSession,
  onToast,
}: {
  accounts: AccountsResponse | null;
  signInSessions: Record<string, SignInSession>;
  unsupported: boolean;
  error: string | null;
  online: boolean;
  onRefresh: () => Promise<void>;
  onSignInSession: (session: SignInSession) => void;
  onToast: (msg: string) => void;
}) {
  const nowMs = useClock(true, 1000);
  const [localUnsupported, setLocalUnsupported] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [newSlotName, setNewSlotName] = useState("acc2");
  const [userEditedSlotName, setUserEditedSlotName] = useState(false);
  const [addSlotError, setAddSlotError] = useState<string | null>(null);
  const [addingSlot, setAddingSlot] = useState(false);

  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderEditDraft | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);

  const slots = accounts?.slots ?? [];
  const providers = accounts?.providers ?? [];
  const quotaLowPct = accounts?.quotaLowPct ?? 20;

  // Prefill suggested slot name (acc2, acc3...) whenever slots change if user hasn't manually edited
  useEffect(() => {
    if (!userEditedSlotName) {
      setNewSlotName(suggestNextSlotName(slots));
    }
  }, [slots, userEditedSlotName]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setActionError(null);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddSlot = async (e: FormEvent) => {
    e.preventDefault();
    const name = newSlotName.trim();
    if (!name) {
      setAddSlotError("Vui lòng nhập tên slot.");
      return;
    }
    const lower = name.toLowerCase();
    const isDuplicate = slots.some(
      (s) => s.name.trim().toLowerCase() === lower || s.id.trim().toLowerCase() === lower
    );
    if (isDuplicate) {
      setAddSlotError(`Tên slot “${name}” đã tồn tại.`);
      return;
    }
    setAddingSlot(true);
    setAddSlotError(null);
    setActionError(null);
    try {
      await createAccountSlot(name);
      setUserEditedSlotName(false);
      await onRefresh();
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setAddingSlot(false);
    }
  };

  const startEditProvider = (row: ProviderRow) => {
    setEditingProviderId(row.id);
    setProviderDraft(toProviderDraft(row));
    setActionError(null);
  };

  const cancelEditProvider = () => {
    setEditingProviderId(null);
    setProviderDraft(null);
  };

  const handleSaveProvider = async (e: FormEvent, id: string) => {
    e.preventDefault();
    if (!providerDraft) return;
    setSavingProvider(true);
    setActionError(null);
    try {
      const parseNum = (s: string): number | null => {
        const t = s.trim();
        if (!t) return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
      };
      const parseResetAt = (s: string): string | null => {
        const t = s.trim();
        if (!t) return null;
        const d = new Date(t);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      };
      const body: PatchProviderRequest = {
        usedPct: parseNum(providerDraft.usedPct),
        sharePct: parseNum(providerDraft.sharePct),
        resetAt: parseResetAt(providerDraft.resetAt),
        resetRule: providerDraft.resetRule.trim() || null,
        limitNote: providerDraft.limitNote.trim() || null,
        note: providerDraft.note.trim() || null,
        source: "manual",
      };
      await patchAccountProvider(id, body);
      cancelEditProvider();
      await onRefresh();
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setSavingProvider(false);
    }
  };

  if (unsupported || localUnsupported) {
    return (
      <div className="notice-box">
        <strong>Hub chưa hỗ trợ</strong>
        <p className="muted small">
          Endpoint Tài khoản &amp; Hạn mức (<code>/api/accounts/*</code>) trả về 404. Hãy cập nhật Hub Daemon.
        </p>
      </div>
    );
  }

  return (
    <div className="accounts-panel">
      <div className="accounts-help">
        <div>
          <strong>Cách thêm tài khoản Antigravity:</strong>{" "}
          <span className="muted">
            Thêm slot → bấm <strong>Đăng nhập Google</strong> (mở trang Google, dán mã nếu có) → hệ thống tự kiểm tra và nạp model/hạn mức.
          </span>
        </div>
        <button
          type="button"
          className="btn ghost small"
          disabled={!online || refreshing}
          onClick={() => void handleRefresh()}
        >
          {refreshing ? "Đang tải…" : "↻ Làm mới"}
        </button>
      </div>

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

      {/* Section (a): Antigravity slots */}
      <section className="accounts-section">
        <div className="accounts-section-head">
          <h3>Antigravity (mỗi tài khoản 1 slot)</h3>
          <div className="add-slot-wrap">
            <form className="add-slot-form" onSubmit={(e) => void handleAddSlot(e)}>
              <input
                type="text"
                className="input small-input"
                placeholder="Tên slot mới (vd: acc2, work)…"
                value={newSlotName}
                disabled={!online || addingSlot}
                onChange={(e) => {
                  setNewSlotName(e.target.value);
                  setUserEditedSlotName(true);
                  if (addSlotError) setAddSlotError(null);
                }}
              />
              <button
                type="submit"
                className="btn ok small"
                disabled={!online || addingSlot}
              >
                {addingSlot ? "Đang thêm…" : "+ Thêm slot"}
              </button>
            </form>
            {addSlotError && <div className="inline-validation">{addSlotError}</div>}
          </div>
        </div>

        {!accounts ? (
          <div className="muted small">Đang tải danh sách tài khoản…</div>
        ) : slots.length === 0 ? (
          <div className="notice-box muted small">Chưa có slot nào. Tạo slot mới ở ô phía trên.</div>
        ) : (
          <div className="slots-grid">
            {slots.map((slot) => (
              <SlotCard
                key={slot.id}
                slot={slot}
                signInSession={signInSessions[slot.id] ?? null}
                quotaLowPct={quotaLowPct}
                nowMs={nowMs}
                online={online}
                onMutated={onRefresh}
                onSignInSession={onSignInSession}
                onToast={onToast}
                onUnsupported={() => setLocalUnsupported(true)}
                onError={setActionError}
              />
            ))}
          </div>
        )}
      </section>

      {/* Section (b): Other providers & bots */}
      <section className="accounts-section">
        <div className="accounts-section-head">
          <h3>Nhà cung cấp &amp; bot khác</h3>
        </div>

        {!accounts ? (
          <div className="muted small">Đang tải danh sách nhà cung cấp…</div>
        ) : providers.length === 0 ? (
          <div className="notice-box muted small">Chưa có dữ liệu nhà cung cấp.</div>
        ) : (
          <div className="provider-table-wrap">
            <table className="provider-table">
              <thead>
                <tr>
                  <th>Nhà cung cấp</th>
                  <th>Phát hiện</th>
                  <th>Sử dụng / Tỷ lệ</th>
                  <th>Đặt lại</th>
                  <th>Hạn mức</th>
                  <th>Ghi chú</th>
                  <th>Nguồn</th>
                  <th>Cập nhật</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {providers.map((row) => {
                  const isEditing = editingProviderId === row.id && providerDraft !== null;
                  const resetCd = formatCountdown(row.resetAt, nowMs);
                  const hasUsed = row.usedPct != null;
                  const hasShare = row.sharePct != null;
                  return (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.label}</strong>
                        <div className="muted tiny">{row.kind}</div>
                      </td>
                      <td className="small">{row.detected ? row.detected : "—"}</td>
                      <td>
                        {!hasUsed && !hasShare ? (
                          <span className="muted">—</span>
                        ) : (
                          <div className="provider-bars">
                            {hasUsed && (
                              <div className="provider-bar-row">
                                <span className="tiny muted">Đã dùng: {row.usedPct}%</span>
                                <div className="quota-bar compact">
                                  <div
                                    className={`quota-fill ${
                                      (row.usedPct ?? 0) >= 90
                                        ? "block"
                                        : (row.usedPct ?? 0) >= 75
                                        ? "warn"
                                        : "ok"
                                    }`}
                                    style={{ width: `${clampPct(row.usedPct ?? 0)}%` }}
                                  />
                                </div>
                              </div>
                            )}
                            {hasShare && (
                              <div className="provider-bar-row">
                                <span className="tiny muted">Tỷ lệ: {row.sharePct}%</span>
                                <div className="quota-bar compact">
                                  <div
                                    className="quota-fill info"
                                    style={{ width: `${clampPct(row.sharePct ?? 0)}%` }}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="small">
                        {row.resetAt ? (
                          <div>
                            <div>{resetCd ? `đặt lại sau ${resetCd}` : "—"}</div>
                            <div className="muted tiny">{formatUtc7(row.resetAt)}</div>
                          </div>
                        ) : row.resetRule ? (
                          row.resetRule
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="small">{row.limitNote || "—"}</td>
                      <td className="small">{row.note || "—"}</td>
                      <td>
                        <span className="chip">{SOURCE_LABEL[row.source]}</span>
                      </td>
                      <td className="tiny muted">{row.updatedAt ? formatUtc7(row.updatedAt) : "—"}</td>
                      <td>
                        <button
                          type="button"
                          className="btn ghost small"
                          disabled={!online || savingProvider}
                          onClick={() => (isEditing ? cancelEditProvider() : startEditProvider(row))}
                        >
                          {isEditing ? "Đóng" : "Sửa"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {editingProviderId && providerDraft && (
          <form
            className="provider-edit-form"
            onSubmit={(e) => void handleSaveProvider(e, editingProviderId)}
          >
            <div className="slot-section-head">
              <strong>
                Chỉnh sửa:{" "}
                {providers.find((p) => p.id === editingProviderId)?.label ?? editingProviderId}
              </strong>
              <span className="chip">{SOURCE_LABEL.manual}</span>
            </div>
            <div className="provider-edit-grid">
              <label className="field">
                <span className="muted tiny">Đã dùng (%)</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  className="input small-input"
                  placeholder="Để trống = —"
                  value={providerDraft.usedPct}
                  onChange={(e) => setProviderDraft({ ...providerDraft, usedPct: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="muted tiny">Tỷ lệ / Share (%)</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  className="input small-input"
                  placeholder="Để trống = —"
                  value={providerDraft.sharePct}
                  onChange={(e) => setProviderDraft({ ...providerDraft, sharePct: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="muted tiny">Thời điểm đặt lại (resetAt)</span>
                <input
                  type="datetime-local"
                  className="input small-input"
                  value={providerDraft.resetAt}
                  onChange={(e) => setProviderDraft({ ...providerDraft, resetAt: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="muted tiny">Quy tắc đặt lại (resetRule)</span>
                <input
                  type="text"
                  className="input small-input"
                  placeholder="vd: Mỗi thứ Hai 00:00"
                  value={providerDraft.resetRule}
                  onChange={(e) => setProviderDraft({ ...providerDraft, resetRule: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="muted tiny">Hạn mức (limitNote)</span>
                <input
                  type="text"
                  className="input small-input"
                  placeholder="vd: 500 req / tháng"
                  value={providerDraft.limitNote}
                  onChange={(e) => setProviderDraft({ ...providerDraft, limitNote: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="muted tiny">Ghi chú (note)</span>
                <input
                  type="text"
                  className="input small-input"
                  placeholder="Ghi chú thêm…"
                  value={providerDraft.note}
                  onChange={(e) => setProviderDraft({ ...providerDraft, note: e.target.value })}
                />
              </label>
            </div>
            <div className="row end">
              <button type="button" className="btn ghost small" onClick={cancelEditProvider}>
                Huỷ
              </button>
              <button type="submit" className="btn ok small" disabled={!online || savingProvider}>
                {savingProvider ? "Đang lưu…" : "Lưu thay đổi"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
