# Task PERF-2: single-panel navigation by clicking desks (apps/office-ui only). Keep all panel features; only change how they are reached. Vietnamese UI, no new deps.
- Header keeps ONLY: brand, Hub connection status, 2D/3D toggle, Stop All (with confirm). Remove the Phòng họp / Tổ chức / Tài khoản & Hạn mức / Thư viện header buttons and the 5-tab modal tab bar.
- One side/drawer panel at a time (`activePanel` state: {kind, id}); Esc or ✕ closes; opening another replaces it. Panels are `React.lazy` loaded with a small Suspense fallback.
- Routing by click (3D and 2D identical):
  - Cursor Hub AI desk or the library shelf next to it -> Library panel, with the Audit view as a sub-tab inside it (Kho kiến thức | Kiểm toán).
  - Giám sát Token desk -> Accounts & quota panel. Show this seat's display name as "Thủ quỹ Token" everywhere in the UI (id stays `giam-sat-token`; the department label can read "Thủ quỹ Token (Giám sát Token)").
  - Meeting table (3D) / "Phòng họp" card (2D) -> Meeting room panel.
  - Ban Giám đốc desk/zone (Ly Van, Trợ lý MẬP) -> Org & tasks panel.
  - Any other agent desk or department zone/card -> a new `DepartmentPanel`: department name, head, members (status, provider, slot, model, bridge), that department's open conversations (link opens the Meeting room on it), its tasks, and actions allowed for the actor (assign task within the department, open a meeting with its members, hand off). Clicking a single agent highlights it inside its department panel (replaces the old AgentPanel; keep the approval queue visible in the side column).
  - The old accounts rack object and duplicated entry points are removed; the approval queue stays where it is.
- `useClock` only ticks while a countdown is actually rendered (pass enabled=false otherwise); no 1 s re-render when the Accounts panel is closed.
- Add a tiny hint in the empty side area: "Bấm vào một bàn hoặc khu phòng ban để mở bảng điều khiển của phòng đó."
Done = `bun run --cwd apps/office-ui build` passes. Commit: `ui: single-panel navigation by clicking desks, minimal header, Thủ quỹ Token`. No push.
