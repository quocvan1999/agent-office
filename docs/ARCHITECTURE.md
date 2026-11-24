# Agent Office 3D & Shared Knowledge Hub

Local-first 3D virtual office that unifies Cursor, Antigravity, Codex, and API-key agents with the shared `~/.cursor/` knowledge hub.

## Locked-In Architecture
1. **Split Local Hub Daemon & 3D Web UI**: Daemon (`apps/hub-daemon`) runs in background with SQLite + WebSocket; UI (`apps/office-ui`) renders 3D office (React Three Fiber) and drops FPS when hidden.
2. **Unified Adapter & Event Protocol**: `packages/protocol` + `packages/adapters` normalize Cursor (`agent -p --output-format stream-json`), Antigravity (`agy --input-format stream-json --output-format stream-json` / `agy acp`), Codex (`codex app-server` / `codex exec --json`), and API keys to one event stream.
3. **Git Worktree Isolation**: Coding tasks run in `~/agent-office-data/worktrees/<task-id>`.
4. **Safety & Token Efficiency Supervisor**:
   - Centralized Approval Queue, step/budget limits, emergency Stop All.
   - 90% deterministic 0-token telemetry in Local Hub (loop guard, context bloat alert, model tier routing, `~/.cursor/` budget check) + 10% periodic/triggered AI Audit reporting to Top Manager (Trợ lý MẬP).
5. **Single Knowledge Source (`~/.cursor/`)**: UI writes ONLY to `~/.cursor/` (backup before write, bump `lyvan-global` plugin version, append `feedback-log.md`, stay within Antigravity 20k token / 24KB limits, never touch secrets), then runs `~/.cursor/scripts/sync-antigravity.sh` and other sync adapters.
6. **Portable Storage & Auto-Provisioner**: Runtime data in `~/agent-office-data/` (`config/`, `bin/`, `db/office.sqlite`, encrypted `vault/secrets.enc`), 1-click Backup/Restore bundling clean `~/.cursor/` snapshot + `toolchain-manifest.json` so a new machine auto-installs missing CLIs.

## Roadmap
- **Phase 1**: Core Hub Daemon, Auto-Discovery, Unified Protocol, Antigravity + Cursor + Codex + API adapters MVP.
- **Phase 2**: 3D Office UI (R3F + WebSocket), Local Trợ lý MẬP Manager, 0-token Token Supervisor telemetry, Approval Queue, Stop All, Git Worktree.
- **Phase 3**: `~/.cursor/` Knowledge Library UI + Sync Engine + Periodic AI Audit for token optimization.
- **Phase 4**: Auto-Provisioner, 1-click Backup/Restore, 2D power-saver mode, Tauri desktop packaging.
