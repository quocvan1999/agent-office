import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  HubHttpError,
  assignTask,
  createOrgAgent,
  deleteOrgAgent,
  handoffTask,
  isNotFoundError,
  patchDepartmentHead,
} from "../hub.ts";
import {
  GROK_BOT_BADGE,
  SLOT_EFFORTS,
  TASK_STATUS_LABEL,
  type AccountSlot,
  type OrgAgent,
  type OrgAgentProvider,
  type OrgResponse,
  type SlotEffort,
  type TaskRecord,
} from "../types.ts";

function formatError(err: unknown): string {
  if (err instanceof HubHttpError) {
    if (err.serverReason) return err.serverReason;
    if (err.serverError) return err.serverError;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export default function OrgPanel({
  org,
  tasks,
  accountSlots,
  orgUnsupported,
  tasksUnsupported,
  orgError,
  tasksError,
  online,
  onRefreshOrg,
  onRefreshTasks,
  onOpenConversation,
}: {
  org: OrgResponse | null;
  tasks: TaskRecord[];
  accountSlots: AccountSlot[];
  orgUnsupported: boolean;
  tasksUnsupported: boolean;
  orgError: string | null;
  tasksError: string | null;
  online: boolean;
  onRefreshOrg: () => Promise<void>;
  onRefreshTasks: () => Promise<void>;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [localUnsupported, setLocalUnsupported] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Add agent form
  const [agentName, setAgentName] = useState("");
  const [agentDept, setAgentDept] = useState("backend");
  const [agentRole, setAgentRole] = useState("");
  const [agentProvider, setAgentProvider] = useState<OrgAgentProvider>("antigravity");
  const [agentSlotId, setAgentSlotId] = useState("default");
  const [agentModel, setAgentModel] = useState("");
  const [agentEffort, setAgentEffort] = useState<SlotEffort>("low");

  // Assign task form
  const [assignTitle, setAssignTitle] = useState("");
  const [assignDept, setAssignDept] = useState("backend");
  const [assignTo, setAssignTo] = useState("");
  const [assignSummary, setAssignSummary] = useState("");

  // Handoff task form
  const [handoffTitle, setHandoffTitle] = useState("");
  const [handoffFrom, setHandoffFrom] = useState("ba-agy-1");
  const [handoffDept, setHandoffDept] = useState("backend");
  const [handoffTo, setHandoffTo] = useState("");
  const [handoffSummary, setHandoffSummary] = useState("");
  const [handoffDecisions, setHandoffDecisions] = useState("");

  const departments = org?.departments ?? [];
  const roles = org?.roles ?? [];
  const agents = org?.agents ?? [];

  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);
  const deptById = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const deptRoles = useMemo(
    () => roles.filter((r) => r.departmentId === agentDept),
    [roles, agentDept]
  );

  // Keep role selection valid when department changes
  useEffect(() => {
    if (deptRoles.length > 0 && !deptRoles.some((r) => r.id === agentRole)) {
      setAgentRole(deptRoles[0].id);
    } else if (deptRoles.length === 0 && roles.length > 0 && !roles.some((r) => r.id === agentRole)) {
      setAgentRole(roles[0].id);
    }
  }, [deptRoles, roles, agentRole]);

  // Keep default slotId valid
  useEffect(() => {
    if (accountSlots.length > 0 && !accountSlots.some((s) => s.id === agentSlotId)) {
      setAgentSlotId(accountSlots[0].id);
    }
  }, [accountSlots, agentSlotId]);

  const selectedSlot = useMemo(
    () => accountSlots.find((s) => s.id === agentSlotId) ?? null,
    [accountSlots, agentSlotId]
  );

  const handleChangeHead = async (departmentId: string, headAgentId: string | null) => {
    setBusy(`head-${departmentId}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await patchDepartmentHead(departmentId, headAgentId);
      await onRefreshOrg();
      setActionNotice("Đã cập nhật trưởng phòng.");
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleAddAgent = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = agentName.trim();
    if (!trimmed || !agentDept || !agentRole) return;
    setBusy("add-agent");
    setActionError(null);
    setActionNotice(null);
    try {
      const isLocal =
        agentProvider === "antigravity" || agentProvider === "cursor" || agentProvider === "codex";
      await createOrgAgent({
        name: trimmed,
        departmentId: agentDept,
        roleId: agentRole,
        kind: agentProvider === "human" ? "human" : agentProvider === "grok_external" ? "grok_bot" : "local_agent",
        provider: agentProvider,
        slotId: agentProvider === "antigravity" ? agentSlotId || null : null,
        model: agentModel.trim() || null,
        effort: agentEffort,
        bridge: isLocal ? "hub" : "none",
      });
      setAgentName("");
      setAgentModel("");
      setActionNotice(`Đã thêm thành viên “${trimmed}”.`);
      await onRefreshOrg();
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteAgent = async (agent: OrgAgent) => {
    setBusy(`del-${agent.id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await deleteOrgAgent(agent.id);
      setActionNotice(`Đã xóa “${agent.name}”.`);
      await onRefreshOrg();
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleAssignTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!assignTitle.trim() || !assignSummary.trim()) return;
    setBusy("assign");
    setActionError(null);
    setActionNotice(null);
    try {
      await assignTask({
        title: assignTitle.trim(),
        departmentId: assignDept,
        toAgentId: assignTo || null,
        summary: assignSummary.trim(),
      });
      setAssignTitle("");
      setAssignSummary("");
      setActionNotice("Đã giao việc thành công.");
      await onRefreshTasks();
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleHandoffTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!handoffTitle.trim() || !handoffSummary.trim() || !handoffFrom) return;
    setBusy("handoff");
    setActionError(null);
    setActionNotice(null);
    try {
      const decisions = handoffDecisions
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const created = await handoffTask(
        {
          title: handoffTitle.trim(),
          fromAgentId: handoffFrom,
          departmentId: handoffDept,
          toAgentId: handoffTo || null,
          summary: handoffSummary.trim(),
          decisions,
        },
        handoffFrom
      );
      setHandoffTitle("");
      setHandoffSummary("");
      setHandoffDecisions("");
      setActionNotice(
        created.conversationId
          ? `Đã bàn giao công việc (tạo hội thoại ${created.conversationId}).`
          : "Đã bàn giao công việc."
      );
      await onRefreshTasks();
    } catch (err) {
      if (isNotFoundError(err)) setLocalUnsupported(true);
      else setActionError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  if (orgUnsupported || localUnsupported) {
    return (
      <div className="notice-box">
        <strong>Hub chưa hỗ trợ</strong>
        <p className="muted small">
          Endpoint Tổ chức &amp; Công việc (<code>/api/org</code>, <code>/api/tasks</code>) trả về 404. Hãy cập nhật Hub
          Daemon.
        </p>
      </div>
    );
  }

  return (
    <div className="org-panel">
      {(orgError || tasksError || actionError) && (
        <div className="banner error-banner small">
          <span>{actionError ?? orgError ?? tasksError}</span>
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

      {/* Add agent form */}
      <section className="org-section">
        <div className="accounts-section-head">
          <h3>Thêm agent mới</h3>
          <button
            type="button"
            className="btn ghost small"
            disabled={!online}
            onClick={() => {
              void onRefreshOrg();
              void onRefreshTasks();
            }}
          >
            ↻ Làm mới
          </button>
        </div>
        <form className="org-form-grid" onSubmit={(e) => void handleAddAgent(e)}>
          <label className="field">
            <span className="muted tiny">Tên agent</span>
            <input
              type="text"
              className="input small-input"
              placeholder="vd: FE-1 (agy)"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span className="muted tiny">Phòng ban</span>
            <select
              className="input small-input"
              value={agentDept}
              onChange={(e) => setAgentDept(e.target.value)}
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="muted tiny">Vai trò</span>
            <select
              className="input small-input"
              value={agentRole}
              onChange={(e) => setAgentRole(e.target.value)}
            >
              {(deptRoles.length > 0 ? deptRoles : roles).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="muted tiny">Nhà cung cấp</span>
            <select
              className="input small-input"
              value={agentProvider}
              onChange={(e) => setAgentProvider(e.target.value as OrgAgentProvider)}
            >
              <option value="antigravity">antigravity</option>
              <option value="cursor">cursor</option>
              <option value="codex">codex</option>
              <option value="grok_external">grok_external</option>
              <option value="human">human</option>
            </select>
          </label>
          <label className="field">
            <span className="muted tiny">Slot (/api/accounts)</span>
            <select
              className="input small-input"
              value={agentSlotId}
              disabled={agentProvider !== "antigravity"}
              onChange={(e) => setAgentSlotId(e.target.value)}
            >
              {accountSlots.length === 0 ? (
                <option value="default">default</option>
              ) : (
                accountSlots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.id})
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="field">
            <span className="muted tiny">Model</span>
            {selectedSlot && selectedSlot.models.length > 0 && agentProvider === "antigravity" ? (
              <select
                className="input small-input"
                value={agentModel}
                onChange={(e) => setAgentModel(e.target.value)}
              >
                <option value="">Mặc định theo slot</option>
                {selectedSlot.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.id})
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="input small-input"
                placeholder="Để trống = mặc định"
                value={agentModel}
                onChange={(e) => setAgentModel(e.target.value)}
              />
            )}
          </label>
          <label className="field">
            <span className="muted tiny">Effort</span>
            <select
              className="input small-input"
              value={agentEffort}
              onChange={(e) => setAgentEffort(e.target.value as SlotEffort)}
            >
              {SLOT_EFFORTS.map((ef) => (
                <option key={ef} value={ef}>
                  {ef}
                </option>
              ))}
            </select>
          </label>
          <div className="field" style={{ justifyContent: "flex-end" }}>
            <button
              type="submit"
              className="btn ok small"
              disabled={!online || busy === "add-agent" || !agentName.trim()}
            >
              {busy === "add-agent" ? "Đang thêm…" : "+ Thêm agent"}
            </button>
          </div>
        </form>
      </section>

      {/* Departments & members */}
      <section className="org-section">
        <h3>Phòng ban &amp; Nhân sự ({agents.length})</h3>
        {!org ? (
          <div className="muted small">Đang tải cơ cấu tổ chức…</div>
        ) : (
          <div className="dept-cards">
            {departments.map((dept) => {
              const members = agents.filter((a) => a.departmentId === dept.id);
              return (
                <article key={dept.id} className="dept-card">
                  <div className="dept-card-head">
                    <div>
                      <strong>{dept.name}</strong>
                      <span className="muted tiny" style={{ marginLeft: 6 }}>
                        ({dept.id})
                      </span>
                    </div>
                    <label className="row compact">
                      <span className="muted tiny">Trưởng phòng:</span>
                      <select
                        className="input small-input"
                        style={{ width: 170 }}
                        value={dept.headAgentId ?? ""}
                        disabled={!online || busy === `head-${dept.id}`}
                        onChange={(e) => void handleChangeHead(dept.id, e.target.value || null)}
                      >
                        <option value="">— Chưa bổ nhiệm —</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {members.length === 0 ? (
                    <div className="muted tiny">Chưa có thành viên trong phòng ban này.</div>
                  ) : (
                    <div className="provider-table-wrap">
                      <table className="provider-table">
                        <thead>
                          <tr>
                            <th>Tên</th>
                            <th>Vai trò</th>
                            <th>Provider</th>
                            <th>Slot / Model</th>
                            <th>Trạng thái</th>
                            <th>Cầu nối</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((m) => {
                            const isGrok = m.kind === "grok_bot" || m.provider === "grok_external";
                            const canDelete = m.kind !== "human" && !m.isAdmin;
                            return (
                              <tr key={m.id}>
                                <td>
                                  <strong>{m.name}</strong>
                                  <div className="row compact" style={{ marginTop: 2, flexWrap: "wrap" }}>
                                    {m.isHead && <span className="chip ok">Trưởng phòng</span>}
                                    {m.isAdmin && <span className="chip">Admin</span>}
                                    {isGrok && <span className="chip warn">{GROK_BOT_BADGE}</span>}
                                  </div>
                                </td>
                                <td className="small">{roleById.get(m.roleId)?.name ?? m.roleId}</td>
                                <td className="small">{m.provider}</td>
                                <td className="small">
                                  {m.slotId ?? "—"} / {m.model ?? "—"}
                                </td>
                                <td className="small">{m.status}</td>
                                <td className="small">
                                  <span className={`chip ${m.bridge === "hub" ? "ok" : ""}`}>
                                    {m.bridge === "hub" ? "hub" : "không có"}
                                  </span>
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    className="btn ghost danger small"
                                    disabled={!online || !canDelete || busy === `del-${m.id}`}
                                    title={canDelete ? "Xóa agent" : "Không thể xóa người dùng / admin"}
                                    onClick={() => void handleDeleteAgent(m)}
                                  >
                                    Xóa
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Tasks: Assign + Handoff + List */}
      <section className="org-section">
        <h3>Công việc &amp; Bàn giao</h3>
        {tasksUnsupported ? (
          <div className="notice-box">
            <strong>Hub chưa hỗ trợ</strong>
            <p className="muted small">
              Endpoint <code>/api/tasks</code> trả về 404.
            </p>
          </div>
        ) : (
          <>
            <div className="two-col">
              <form className="subform-box" onSubmit={(e) => void handleAssignTask(e)}>
                <strong className="small">Giao việc (Assign)</strong>
                <input
                  type="text"
                  className="input small-input"
                  placeholder="Tiêu đề công việc…"
                  value={assignTitle}
                  onChange={(e) => setAssignTitle(e.target.value)}
                  required
                />
                <div className="two-col">
                  <select
                    className="input small-input"
                    value={assignDept}
                    onChange={(e) => setAssignDept(e.target.value)}
                  >
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input small-input"
                    value={assignTo}
                    onChange={(e) => setAssignTo(e.target.value)}
                  >
                    <option value="">— Theo phòng ban —</option>
                    {agents
                      .filter((a) => a.departmentId === assignDept)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </div>
                <input
                  type="text"
                  className="input small-input"
                  placeholder="Tóm tắt yêu cầu…"
                  value={assignSummary}
                  onChange={(e) => setAssignSummary(e.target.value)}
                  required
                />
                <button
                  type="submit"
                  className="btn ok small"
                  disabled={!online || busy === "assign" || !assignTitle.trim() || !assignSummary.trim()}
                >
                  {busy === "assign" ? "Đang giao…" : "Giao việc"}
                </button>
              </form>

              <form className="subform-box" onSubmit={(e) => void handleHandoffTask(e)}>
                <strong className="small">Bàn giao liên phòng ban (Handoff)</strong>
                <input
                  type="text"
                  className="input small-input"
                  placeholder="Tiêu đề bàn giao…"
                  value={handoffTitle}
                  onChange={(e) => setHandoffTitle(e.target.value)}
                  required
                />
                <div className="two-col">
                  <select
                    className="input small-input"
                    value={handoffFrom}
                    onChange={(e) => setHandoffFrom(e.target.value)}
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        Từ: {a.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input small-input"
                    value={handoffDept}
                    onChange={(e) => setHandoffDept(e.target.value)}
                  >
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        Sang: {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <select
                  className="input small-input"
                  value={handoffTo}
                  onChange={(e) => setHandoffTo(e.target.value)}
                >
                  <option value="">— Người nhận mặc định (Trưởng phòng) —</option>
                  {agents
                    .filter((a) => a.departmentId === handoffDept)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
                <input
                  type="text"
                  className="input small-input"
                  placeholder="Tóm tắt bàn giao…"
                  value={handoffSummary}
                  onChange={(e) => setHandoffSummary(e.target.value)}
                  required
                />
                <textarea
                  rows={2}
                  className="input small-input"
                  placeholder="Các quyết định đã chốt (mỗi dòng 1 ý, không bắt buộc)…"
                  value={handoffDecisions}
                  onChange={(e) => setHandoffDecisions(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn small"
                  disabled={!online || busy === "handoff" || !handoffTitle.trim() || !handoffSummary.trim()}
                >
                  {busy === "handoff" ? "Đang bàn giao…" : "Bàn giao"}
                </button>
              </form>
            </div>

            {tasks.length === 0 ? (
              <div className="muted small">Chưa có công việc nào.</div>
            ) : (
              <div className="provider-table-wrap">
                <table className="provider-table">
                  <thead>
                    <tr>
                      <th>Tiêu đề</th>
                      <th>Loại</th>
                      <th>Từ → Phòng ban / Người nhận</th>
                      <th>Tóm tắt &amp; Quyết định</th>
                      <th>Trạng thái</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.title}</strong>
                        </td>
                        <td>
                          <span className="chip">{t.kind === "handoff" ? "Bàn giao" : "Giao việc"}</span>
                        </td>
                        <td className="small">
                          {agentById.get(t.fromAgentId)?.name ?? t.fromAgentId} →{" "}
                          {deptById.get(t.departmentId)?.name ?? t.departmentId}
                          {t.toAgentId ? ` (${agentById.get(t.toAgentId)?.name ?? t.toAgentId})` : ""}
                        </td>
                        <td className="small">
                          <div>{t.summary}</div>
                          {t.decisions?.length > 0 && (
                            <ul className="tiny muted" style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                              {t.decisions.map((d, i) => (
                                <li key={i}>{d}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td>
                          <span className="chip">{TASK_STATUS_LABEL[t.status] ?? t.status}</span>
                        </td>
                        <td>
                          {t.conversationId && (
                            <button
                              type="button"
                              className="btn ghost small"
                              onClick={() => onOpenConversation(t.conversationId!)}
                            >
                              Mở hội thoại
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
