# Task P3-UI (apps/office-ui only). Read docs/specs/phase3-contract.md first; consume it exactly (Hub may not be updated yet: handle 404 gracefully with a "Hub chưa hỗ trợ" notice).
Edit only apps/office-ui/**. React + R3F, no new npm deps. Match existing style (components/, hub.ts, types.ts). UI text in Vietnamese.

1. types.ts/hub.ts: add contract types + fetch helpers (tree, file, save, sync, audit latest/run, dev test approval); handle WS `library_changed`, `audit_report`, `sync_result` (refresh state).
2. 3D: add a "Thư viện" bookshelf corner object in Office3D (simple boxes, clickable, label) and a matching card in SeatGrid2D (2D mode). Click opens the Library panel.
3. `components/LibraryPanel.tsx`: left list grouped by area with token count per file and a filter box; right side shows file in a monospace textarea; Save requires a note (input), sends expectedMtime, shows backupPath + new plugin version, handles 409 ("File đã bị sửa ở nơi khác, tải lại"). Disable editing when `writable=false`. Buttons: "Đồng bộ thử (dry-run)" and "Đồng bộ thật" (confirm dialog) calling sync; show output in a collapsible <pre>.
4. `components/AuditPanel.tsx` (shown in the Token Supervisor area or a tab next to Library): totals, findings sorted by severity with colored badges, estSavedTokens, buttons "Chạy kiểm tra (0 token)" and "Hỏi AI (agy)" (ai:true; show 429 nicely), aiSummary rendered as preformatted text.
5. A small dev button "Tạo yêu cầu duyệt thử" in the approval queue header calling POST /api/dev/test-approval (hide on 404).
Done = `bun run --cwd apps/office-ui build` passes with no TS errors. Commit on current branch: `feat(phase3): library corner, audit panel, dev test approval button (ui)`. Do not push.
