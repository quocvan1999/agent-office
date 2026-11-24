import { useCallback, useEffect, useMemo, useState } from "react";
import {
  HubHttpError,
  fetchLibraryFile,
  fetchLibraryTree,
  isNotFoundError,
  saveLibraryFile,
  syncLibrary,
} from "../hub.ts";
import type {
  LibArea,
  LibEntry,
  LibraryTreeResponse,
  SaveLibraryFileResponse,
  SyncResult,
} from "../types.ts";

const AREA_ORDER: LibArea[] = ["rules", "kits", "skills", "agents", "hooks", "feedback"];
const AREA_LABEL: Record<LibArea, string> = {
  rules: "Rules",
  kits: "Project Kits",
  skills: "Skills",
  agents: "Agents",
  hooks: "Hooks",
  feedback: "Feedback",
};

export default function LibraryPanel({
  online,
  libraryRevision,
  lastChangedPath,
  lastSyncResult,
  onSyncResult,
}: {
  online: boolean;
  libraryRevision: number;
  lastChangedPath: string | null;
  lastSyncResult: SyncResult | null;
  onSyncResult: (result: SyncResult) => void;
}) {
  const [tree, setTree] = useState<LibraryTreeResponse | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [mtime, setMtime] = useState<string | undefined>(undefined);
  const [savedTokens, setSavedTokens] = useState<number>(0);
  const [staleNotice, setStaleNotice] = useState(false);

  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict409, setConflict409] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<SaveLibraryFileResponse | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [confirmRealSync, setConfirmRealSync] = useState(false);
  const [syncExpanded, setSyncExpanded] = useState(false);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      const data = await fetchLibraryTree();
      setTree(data);
      setUnsupported(false);
    } catch (e) {
      if (isNotFoundError(e)) {
        setUnsupported(true);
      } else {
        setTreeError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const loadFile = useCallback(async (path: string) => {
    setSelectedPath(path);
    setFileLoading(true);
    setFileError(null);
    setSaveError(null);
    setConflict409(false);
    setSaveSuccess(null);
    setStaleNotice(false);
    try {
      const data = await fetchLibraryFile(path);
      setContent(data.content);
      setOriginalContent(data.content);
      setMtime(data.mtime);
      setSavedTokens(data.tokens);
      setUnsupported(false);
    } catch (e) {
      if (isNotFoundError(e)) {
        setUnsupported(true);
      } else {
        setFileError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setFileLoading(false);
    }
  }, []);

  useEffect(() => {
    if (online) void loadTree();
  }, [online, libraryRevision, loadTree]);

  useEffect(() => {
    if (!selectedPath || libraryRevision === 0) return;
    if (lastChangedPath && lastChangedPath !== selectedPath) return;
    if (content === originalContent) {
      void loadFile(selectedPath);
    } else {
      setStaleNotice(true);
    }
  }, [libraryRevision, lastChangedPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lastSyncResult) setSyncExpanded(true);
  }, [lastSyncResult]);

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const entries = (tree?.entries ?? []).filter((entry) => {
      if (!q) return true;
      return entry.path.toLowerCase().includes(q) || entry.area.toLowerCase().includes(q);
    });
    const map = new Map<LibArea, LibEntry[]>();
    for (const area of AREA_ORDER) map.set(area, []);
    for (const entry of entries) {
      const list = map.get(entry.area);
      if (list) list.push(entry);
      else map.set(entry.area, [entry]);
    }
    return AREA_ORDER.map((area) => ({
      area,
      label: AREA_LABEL[area],
      items: (map.get(area) ?? []).sort((a, b) => a.path.localeCompare(b.path)),
    })).filter((g) => g.items.length > 0);
  }, [tree, filter]);

  const writable = tree?.writable ?? false;
  const dirty = selectedPath !== null && content !== originalContent;
  const trimmedNote = note.trim();
  const noteValid = trimmedNote.length >= 3 && trimmedNote.length <= 200;
  const liveTokens = Math.ceil(content.length / 4);

  const handleSave = async () => {
    if (!selectedPath || !writable || !noteValid) return;
    setSaving(true);
    setSaveError(null);
    setConflict409(false);
    setSaveSuccess(null);
    try {
      const res = await saveLibraryFile({
        path: selectedPath,
        content,
        note: trimmedNote,
        expectedMtime: mtime,
      });
      setSaveSuccess(res);
      setOriginalContent(content);
      setSavedTokens(res.tokensAfter);
      setNote("");
      setStaleNotice(false);
      // Reload file metadata (new mtime) and tree token counts
      const fresh = await fetchLibraryFile(selectedPath);
      setMtime(fresh.mtime);
      setSavedTokens(fresh.tokens);
      void loadTree();
    } catch (e) {
      if (e instanceof HubHttpError && e.status === 409) {
        setConflict409(true);
        setSaveError("File đã bị sửa ở nơi khác, tải lại");
      } else if (isNotFoundError(e)) {
        setUnsupported(true);
      } else {
        setSaveError(e instanceof HubHttpError && e.serverError ? e.serverError : String(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async (dryRun: boolean) => {
    setConfirmRealSync(false);
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await syncLibrary(dryRun);
      onSyncResult(res);
      setSyncExpanded(true);
    } catch (e) {
      if (isNotFoundError(e)) {
        setUnsupported(true);
      } else {
        setSyncError(e instanceof HubHttpError && e.serverError ? e.serverError : String(e));
      }
    } finally {
      setSyncing(false);
    }
  };

  if (unsupported) {
    return (
      <div className="notice-box">
        <strong>Hub chưa hỗ trợ</strong>
        <p className="muted small">
          Endpoint Thư viện (<code>/api/library/*</code>) trả về 404. Hãy cập nhật Hub Daemon lên Giai đoạn 3.
        </p>
      </div>
    );
  }

  return (
    <div className="library-layout">
      <div className="library-sidebar">
        <div className="library-toolbar">
          <input
            type="search"
            className="input"
            placeholder="Lọc file hoặc khu vực…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="btn ghost small" onClick={() => void loadTree()} disabled={!online || treeLoading}>
            {treeLoading ? "…" : "↻"}
          </button>
        </div>
        {tree && (
          <div className="muted small library-meta">
            <span>{tree.entries.length} file</span>
            <span className={`chip ${tree.writable ? "ok" : "warn"}`}>
              {tree.writable ? "có thể sửa" : "chỉ đọc"}
            </span>
          </div>
        )}
        {treeError && <p className="error small">{treeError}</p>}
        <div className="library-tree">
          {grouped.length === 0 && !treeLoading && (
            <p className="muted small">Không có file nào khớp bộ lọc.</p>
          )}
          {grouped.map((group) => (
            <div key={group.area} className="library-group">
              <div className="library-group-head">
                <strong>{group.label}</strong>
                <span className="muted small">{group.items.length}</span>
              </div>
              <ul className="library-list">
                {group.items.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className={`library-item ${selectedPath === entry.path ? "active" : ""}`}
                      onClick={() => void loadFile(entry.path)}
                      title={entry.path}
                    >
                      <span className="library-path">{entry.path}</span>
                      <span className="library-tokens">{entry.tokens.toLocaleString("vi-VN")} tok</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="library-editor">
        <div className="library-sync-bar">
          <div className="muted small">
            {tree?.root ? (
              <>
                Gốc: <code>{tree.root}</code>
              </>
            ) : (
              "Đang tải danh sách thư viện…"
            )}
          </div>
          <div className="row compact">
            <button
              className="btn"
              disabled={!online || syncing}
              onClick={() => void handleSync(true)}
            >
              {syncing ? "Đang đồng bộ…" : "Đồng bộ thử (dry-run)"}
            </button>
            <button
              className="btn ok"
              disabled={!online || syncing}
              onClick={() => setConfirmRealSync(true)}
            >
              Đồng bộ thật
            </button>
          </div>
        </div>

        {syncError && <p className="error small">{syncError}</p>}

        {lastSyncResult && (
          <details
            className={`sync-output ${lastSyncResult.ok ? "ok" : "fail"}`}
            open={syncExpanded}
            onToggle={(e) => setSyncExpanded((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>
              <span>
                {lastSyncResult.dryRun ? "Đồng bộ thử" : "Đồng bộ thật"} ·{" "}
                {lastSyncResult.ok ? "Thành công" : `Lỗi (mã ${lastSyncResult.exitCode})`}
                {lastSyncResult.skipped ? ` · bỏ qua: ${lastSyncResult.skipped}` : ""}
              </span>
            </summary>
            <pre>{lastSyncResult.output || "(không có output)"}</pre>
          </details>
        )}

        {!selectedPath ? (
          <div className="library-empty muted">
            Chọn một file ở cột bên trái để xem hoặc chỉnh sửa.
          </div>
        ) : fileLoading ? (
          <div className="library-empty muted">Đang tải {selectedPath}…</div>
        ) : fileError ? (
          <div className="library-empty">
            <p className="error">{fileError}</p>
            <button className="btn" onClick={() => void loadFile(selectedPath)}>
              Thử lại
            </button>
          </div>
        ) : (
          <>
            <div className="editor-head">
              <div>
                <code className="editor-path">{selectedPath}</code>
                <div className="muted small">
                  {liveTokens.toLocaleString("vi-VN")} token
                  {liveTokens !== savedTokens && ` (trước: ${savedTokens.toLocaleString("vi-VN")})`}
                  {mtime && ` · sửa lúc ${new Date(mtime).toLocaleString("vi-VN")}`}
                </div>
              </div>
              <div className="row compact">
                {!writable && <span className="chip warn">Chỉ đọc (writable=false)</span>}
                {dirty && <span className="chip warn">Chưa lưu</span>}
                <button className="btn ghost small" onClick={() => void loadFile(selectedPath)}>
                  Tải lại
                </button>
              </div>
            </div>

            {staleNotice && (
              <div className="banner warn">
                <span>File vừa thay đổi ở nơi khác.</span>
                <button className="btn small" onClick={() => void loadFile(selectedPath)}>
                  Tải lại
                </button>
              </div>
            )}

            <textarea
              className="code-editor"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={!writable}
              readOnly={!writable}
              spellCheck={false}
            />

            <div className="editor-save-bar">
              <input
                type="text"
                className="input note-input"
                placeholder={
                  writable
                    ? "Ghi chú thay đổi (bắt buộc, 3–200 ký tự)…"
                    : "Chế độ chỉ đọc — không thể lưu thay đổi"
                }
                value={note}
                maxLength={200}
                disabled={!writable || saving}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="btn ok"
                disabled={!online || !writable || saving || !noteValid}
                onClick={() => void handleSave()}
                title={!noteValid ? "Nhập ghi chú từ 3 đến 200 ký tự để lưu" : undefined}
              >
                {saving ? "Đang lưu…" : "Lưu file"}
              </button>
            </div>

            {saveError && (
              <div className="banner error-banner">
                <span>{saveError}</span>
                {conflict409 && (
                  <button className="btn small" onClick={() => void loadFile(selectedPath)}>
                    Tải lại
                  </button>
                )}
              </div>
            )}

            {saveSuccess && (
              <div className="banner ok-banner small">
                Đã lưu · phiên bản plugin: <strong>v{saveSuccess.pluginVersion}</strong> · token:{" "}
                {saveSuccess.tokensBefore} → {saveSuccess.tokensAfter} · backup:{" "}
                <code>{saveSuccess.backupPath}</code>
              </div>
            )}
          </>
        )}
      </div>

      {confirmRealSync && (
        <div className="modal-backdrop" onClick={() => setConfirmRealSync(false)}>
          <div className="modal confirm-sync" onClick={(e) => e.stopPropagation()}>
            <h3>Chạy đồng bộ thật?</h3>
            <p className="muted">
              Thao tác này sẽ ghi thay đổi từ kho <code>~/.cursor</code> sang các ứng dụng đích. Bạn có chắc muốn tiếp
              tục?
            </p>
            <div className="row end">
              <button className="btn ghost" onClick={() => setConfirmRealSync(false)}>
                Huỷ
              </button>
              <button className="btn ok" onClick={() => void handleSync(false)}>
                Xác nhận đồng bộ thật
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
