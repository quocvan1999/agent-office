# Token Efficiency & 0-Token Guard Policy

Authored with **Giám sát Token** for `apps/hub-daemon`. All thresholds live in `~/agent-office-data/config/policies.json` (seeded from `config/policies.default.json`) so the 3D UI can adjust them without code edits.

1. **Loop Guard (0 token)**:
   - Repeated edit on same file: warn at 3, abort at 4 within 10 minutes.
   - Repeated failing command signature: warn at 2, abort at 3 consecutive or 4 per task.
   - No-progress read-only burst: abort at 8 consecutive read/search calls without diff, or > 25 steps (40 for large tasks).
2. **Context Bloat Guard (0 token)**:
   - Estimate tokens as `Math.ceil(chars / 3.5)`; trim tool outputs > 25k chars (keep head + tail).
   - Yellow warning at >= 12 turns or >= 140k chars; red at >= 20 turns or >= 280k chars -> compact to <= 1.5k char brief or start clean session.
3. **Rule-based Router (Tiers 0-3)**:
   - Tier 0 (light API): summaries, classification, commit notes.
   - Tier 1 (Antigravity `agy` with `--effort low|medium`): UI, well-specified CRUD, tests, 1-3 file refactors. Pin 1 account per session to preserve prompt cache; rotate pool only on cooldown/quota_low.
   - Tier 2 (Codex CLI): verifiable batch/worktree work.
   - Tier 3 (Cursor `agent`): core daemon/adapters, hard multi-file bugs, escalation after Tier 1-2 failure.
4. **`~/.cursor/` Budget Linter (0 token)**:
   - Always-on rules (`Math.ceil(bytes / 3.2)`): warn >= 15k, block write/sync >= 19k (hard limit 20k).
   - Antigravity rule files: warn >= 20 KB, block sync >= 23.5 KB (hard limit 24 KB).
   - Warn when `feedback-log.md` exceeds 150 lines.
