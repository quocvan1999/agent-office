# Accounts & Quota contract (Hub <-> UI). JSON on 127.0.0.1:4789, errors `{error}`.

## Facts found about agy 1.5.x (verified 24/11/2026)
- `HOME=<dir> agy models` -> one `id<TAB>label` per line when signed in; when not: exit!=0 and stderr contains "Please sign in".
- `HOME=<dir> agy --print=/quota` (no model tokens, ~3s) -> lines `<group>\t<window>\t<NN%>\t<ISO reset UTC>`, e.g. `Gemini Models\tWeekly Limit Remaining\t97%\t2026-12-01T08:57:55Z`, `Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-24T14:17:13Z`.
- `agy --print=/credits` -> `Remaining credits\t<n>` (+ an Upgrade line).
- Signed-in email: last `email=<addr>` match in `<HOME>/.gemini/antigravity-cli/cli.log` (parse ONLY the address; never read other files there).
- stream-json `result.usage` = {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}; errors print `AGY_ERROR: {"short_error","status","retryable","reason"}`. Quota errors: status RESOURCE_EXHAUSTED or text matching /quota|exhausted|rate.?limit|429/i.
- IMPORTANT: always pass the prompt as `--print=<prompt>` (bare `--print` swallows the next flag).

## Types
`Source = "provider" | "measured" | "manual" | "provider_snapshot"` (UI labels: "từ nhà cung cấp", "tự đo", "nhập tay", "ảnh chụp từ nhà cung cấp").
`QuotaWindow = { group: string, window: string, remainingPct: number, resetAt: string, source: Source, fetchedAt: string }`
`Slot = { id, name, homeDir, isDefault: boolean, enabled: boolean, model: string|null, effort: "low"|"medium"|"high"|"xhigh"|"max", status: "ready"|"cooldown"|"quota_low"|"signed_out"|"unknown", email: string|null, models: {id,label}[], quota: QuotaWindow[], credits: number|null, measured: { requests: number, totalTokens: number, lastJobAt: string|null, source: "measured" }, cooldownUntil: string|null, lastQuotaError: {at, message}|null, manual: { limitNote?: string, resetRule?: string } , lastCheckedAt: string|null, signInCommand: string }`
`ProviderRow = { id, label, kind: "cursor"|"codex"|"grok_plan"|"grok_bot", detected?: string, usedPct?: number|null, sharePct?: number|null, resetAt?: string|null, resetRule?: string|null, limitNote?: string|null, note?: string|null, source: Source|"none", updatedAt: string|null }`

## Endpoints
- `GET /api/accounts` -> `{ slots: Slot[], providers: ProviderRow[], quotaLowPct: number }`
- `POST /api/accounts/slots` `{name}` -> `Slot` (creates `~/agent-office-data/profiles/<slug>` mode 700; slug from name, unique)
- `PATCH /api/accounts/slots/:id` `{name?, model?, effort?, enabled?, manual?}` -> `Slot` (model must be in slot.models when models non-empty)
- `DELETE /api/accounts/slots/:id?purge=1` -> `{ok}` (default slot cannot be deleted; purge removes dir only if inside profiles root)
- `POST /api/accounts/slots/:id/check` -> `Slot` (runs models + /quota + /credits + email)
- `POST /api/accounts/slots/:id/signin` `{openTerminal?: boolean}` -> `{ command: string, opened: boolean }`
- `PATCH /api/accounts/providers/:id` `{usedPct?, sharePct?, resetAt?, resetRule?, limitNote?, note?, source?: "manual"|"provider_snapshot"}` -> `ProviderRow`
- `POST /api/agy/jobs` `{prompt, cwd, slotId?, model?, effort?, autoEdit?: boolean}` -> `{ jobId, slotId }`; `GET /api/agy/jobs/:id` -> `{ id, status: "queued"|"running"|"done"|"error"|"waiting_approval", slotId, attempts: {slotId, outcome}[], usage?, error? }`
- WS: `{type:"accounts_changed"}` whenever slots/providers/quota change; `{type:"agy_job", job}` on job updates.
