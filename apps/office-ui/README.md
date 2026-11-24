# office-ui — Agent Office 3D

React + Vite + React Three Fiber UI for the Local Hub Daemon.

```bash
bun install            # at repo root
bun run dev:hub        # Hub Daemon → http://127.0.0.1:4789
bun run dev:ui         # UI → http://127.0.0.1:5173
bun run --cwd apps/office-ui build   # typecheck + production build
```

Hub address: `VITE_HUB_HOST` / `VITE_HUB_PORT` (default `127.0.0.1:4789`).

Features: 3D office (Trợ lý MẬP, Giám sát Token, Antigravity, Cursor, Codex, API keys desks),
live WebSocket with exponential-backoff reconnect (1s → 15s), approval queue, Stop All (with confirm),
`~/.cursor` always-on budget meter, and a 2D power-saver mode (unmounts WebGL; three.js chunk is
lazy-loaded; render loop pauses when the tab is hidden; persisted in localStorage).
