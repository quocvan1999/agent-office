# Phase 3 API contract (Hub <-> UI) — Knowledge Library, Sync, AI Audit

All JSON, served by hub-daemon on 127.0.0.1:4789. Errors: `{ "error": string }` with 4xx/5xx.

- `GET /api/library/tree` -> `{ root: string, writable: boolean, entries: LibEntry[] }`
  `LibEntry = { path: string /* relative to root, posix */, area: "rules"|"kits"|"skills"|"agents"|"hooks"|"feedback", size: number, tokens: number /* ceil(chars/4) */, mtime: string /* ISO */ }`
- `GET /api/library/file?path=<rel>` -> `{ path, content: string, tokens: number, mtime }`
- `PUT /api/library/file` body `{ path, content, note: string /* required, 3..200 chars */, expectedMtime?: string }`
  -> `{ ok: true, backupPath: string, pluginVersion: string /* after bump */, tokensBefore, tokensAfter }`. 409 if expectedMtime mismatches.
- `POST /api/library/sync` body `{ dryRun?: boolean /* default true */ }` -> `{ ok: boolean, dryRun: boolean, exitCode: number, output: string /* max 8000 chars */, skipped?: string }`
- `GET /api/audit/latest` -> `AuditReport | { report: null }`
- `POST /api/audit/run` body `{ ai?: boolean /* default false */ }` -> `AuditReport`
  `AuditReport = { id: string, at: string, kind: "rule"|"ai", totals: { files: number, tokens: number, alwaysLoadedTokens: number }, findings: Finding[], aiSummary?: string }`
  `Finding = { severity: "info"|"warning"|"critical", code: string, path?: string, message: string, estSavedTokens?: number }`
- `POST /api/dev/test-approval` body `{ action?: string }` -> `{ approval: PendingApproval }` (only when hub started with `HUB_DEV=1`, else 404)
- WebSocket broadcasts (same envelope style the hub already uses for other messages): `{ type: "library_changed", path }`, `{ type: "audit_report", report: AuditReport }`, `{ type: "sync_result", result }`.
