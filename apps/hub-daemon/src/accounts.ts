import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  AntigravityAdapter,
  type AgyEffort,
  type AgyUsage,
} from "../../../packages/adapters/src/antigravity.ts";
import type { OfficeDatabase, ProviderDbRow, SlotDbRow, SlotUsageRow } from "./db.ts";
import type { HubOrchestrator } from "./orchestrator.ts";
import { getDataDir } from "./policy.ts";

export type Source = "provider" | "measured" | "manual" | "provider_snapshot";

export interface QuotaWindow {
  group: string;
  window: string;
  remainingPct: number;
  resetAt: string;
  source: Source;
  fetchedAt: string;
}

export interface SlotModel {
  id: string;
  label: string;
}

export type SlotEffort = AgyEffort;
export type SlotStatus = "ready" | "cooldown" | "quota_low" | "signed_out" | "unknown";

export interface Slot {
  id: string;
  name: string;
  homeDir: string;
  isDefault: boolean;
  enabled: boolean;
  model: string | null;
  effort: SlotEffort;
  status: SlotStatus;
  email: string | null;
  models: SlotModel[];
  quota: QuotaWindow[];
  credits: number | null;
  measured: {
    requests: number;
    totalTokens: number;
    lastJobAt: string | null;
    source: "measured";
  };
  cooldownUntil: string | null;
  lastQuotaError: { at: string; message: string } | null;
  manual: { limitNote?: string; resetRule?: string };
  lastCheckedAt: string | null;
  signInCommand: string;
}

export type ProviderKind = "cursor" | "codex" | "grok_plan" | "grok_bot";

export interface ProviderRow {
  id: string;
  label: string;
  kind: ProviderKind;
  detected?: string;
  usedPct?: number | null;
  sharePct?: number | null;
  resetAt?: string | null;
  resetRule?: string | null;
  limitNote?: string | null;
  note?: string | null;
  source: Source | "none";
  updatedAt: string | null;
}

export type AgyJobStatus = "queued" | "running" | "done" | "error" | "waiting_approval";

export interface AgyJobAttempt {
  slotId: string;
  outcome: string;
}

export interface AgyJob {
  id: string;
  status: AgyJobStatus;
  slotId: string;
  attempts: AgyJobAttempt[];
  usage?: AgyUsage;
  error?: string;
}

export interface CreateAgyJobInput {
  prompt: string;
  cwd: string;
  slotId?: string;
  model?: string;
  effort?: SlotEffort;
  autoEdit?: boolean;
}

export interface PinnedTurnInput {
  slotId?: string | null;
  prompt: string;
  cwd?: string;
  model?: string | null;
  effort?: SlotEffort;
  agentId?: string;
  taskId?: string;
  printTimeout?: string;
}

export interface PinnedTurnResult {
  ok: boolean;
  slotId: string;
  text: string;
  usage?: AgyUsage;
  error?: string;
}

export interface AccountsServiceOptions {
  db: OfficeDatabase;
  orchestrator: HubOrchestrator;
  agyBin?: string;
  profilesRoot?: string;
  quotaLowPct?: number;
  quotaRefreshMin?: number;
  repoRoot?: string;
  onAccountsChanged?: () => void;
  onJobUpdate?: (job: AgyJob) => void;
}

export class AccountsError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AccountsError";
  }
}

const VALID_EFFORTS = new Set<SlotEffort>(["low", "medium", "high", "xhigh", "max"]);
const AGY_CMD_TIMEOUT_MS = 30_000;
const MAX_JOBS_IN_MEMORY = 50;
const QUOTA_ERROR_RE = /quota|exhausted|rate.?limit|429/i;
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/;

const SEEDED_PROVIDERS: ProviderDbRow[] = [
  {
    id: "cursor",
    label: "Cursor",
    kind: "cursor",
    used_pct: null,
    share_pct: null,
    reset_at: null,
    reset_rule: null,
    limit_note: null,
    note: "Không có dữ liệu hạn mức cục bộ; Cursor dùng chung hạn mức tuần của gói với Grok Bot",
    source: "none",
    updated_at: null,
  },
  {
    id: "codex",
    label: "Codex CLI",
    kind: "codex",
    used_pct: null,
    share_pct: null,
    reset_at: null,
    reset_rule: null,
    limit_note: null,
    note: null,
    source: "none",
    updated_at: null,
  },
  {
    id: "grok-plan",
    label: "Gói Grok Bot Premium (dùng chung Grok Bot + Cursor)",
    kind: "grok_plan",
    used_pct: null,
    share_pct: null,
    reset_at: null,
    reset_rule: "Hằng tuần, thứ Ba 15:40 (UTC+7)",
    limit_note: null,
    note: null,
    source: "none",
    updated_at: null,
  },
  {
    id: "tro-ly-map",
    label: "Trợ lý MẬP",
    kind: "grok_bot",
    used_pct: null,
    share_pct: null,
    reset_at: null,
    reset_rule: null,
    limit_note: null,
    note: null,
    source: "none",
    updated_at: null,
  },
  {
    id: "giam-sat-token",
    label: "Giám sát Token",
    kind: "grok_bot",
    used_pct: null,
    share_pct: null,
    reset_at: null,
    reset_rule: null,
    limit_note: null,
    note: null,
    source: "none",
    updated_at: null,
  },
  {
    id: "chuyen-gia-ba",
    label: "Chuyên gia BA",
    kind: "grok_bot",
    used_pct: null,
    share_pct: null,
    reset_at: null,
    reset_rule: null,
    limit_note: null,
    note: null,
    source: "none",
    updated_at: null,
  },
  {
    id: "hacker-lo",
    label: "Hacker Lõ",
    kind: "grok_bot",
    used_pct: null,
    share_pct: null,
    reset_at: null,
    reset_rule: null,
    limit_note: null,
    note: null,
    source: "none",
    updated_at: null,
  },
  {
    id: "tcs-ai-lab",
    label: "TCS AI Lab",
    kind: "grok_bot",
    used_pct: null,
    share_pct: null,
    reset_at: null,
    reset_rule: null,
    limit_note: null,
    note: null,
    source: "none",
    updated_at: null,
  },
  {
    id: "cursor-hub-ai",
    label: "Cursor Hub AI",
    kind: "grok_bot",
    used_pct: null,
    share_pct: null,
    reset_at: null,
    reset_rule: null,
    limit_note: null,
    note: null,
    source: "none",
    updated_at: null,
  },
  {
    id: "tho-code",
    label: "Thợ Code",
    kind: "grok_bot",
    used_pct: null,
    share_pct: null,
    reset_at: null,
    reset_rule: null,
    limit_note: null,
    note: null,
    source: "none",
    updated_at: null,
  },
];

function slugifyName(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "slot";
}

function buildSignInCommand(homeDir: string, isDefault: boolean): string {
  if (isDefault) return "~/.gemini/bin/agy";
  const escapedDir = homeDir.replace(/'/g, "'\\''");
  return `HOME='${escapedDir}' ~/.gemini/bin/agy`;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseModelsOutput(stdout: string): SlotModel[] {
  const models: SlotModel[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    const id = parts[0]?.trim();
    if (!id) continue;
    const label = (parts[1] ?? id).trim();
    models.push({ id, label });
  }
  return models;
}

function parseQuotaOutput(stdout: string, fetchedAt: string): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 4) continue;
    const group = parts[0]?.trim() ?? "";
    const windowName = parts[1]?.trim() ?? "";
    const pctRaw = parts[2]?.trim() ?? "";
    const resetAt = parts[3]?.trim() ?? "";
    if (!group || !windowName || !pctRaw.includes("%")) continue;
    const pct = Number.parseFloat(pctRaw.replace("%", ""));
    if (!Number.isFinite(pct)) continue;
    windows.push({
      group,
      window: windowName,
      remainingPct: pct,
      resetAt,
      source: "provider",
      fetchedAt,
    });
  }
  return windows;
}

function parseCreditsOutput(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    const match = line.match(/Remaining credits\t([\d.,]+)/i);
    if (match?.[1]) {
      const value = Number.parseFloat(match[1].replace(/,/g, ""));
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function readEmailFromCliLog(homeDir: string): string | null {
  const logPath = join(homeDir, ".gemini", "antigravity-cli", "cli.log");
  if (!existsSync(logPath)) return null;
  try {
    const content = readFileSync(logPath, "utf8");
    let lastEmail: string | null = null;
    const re = /email=([^\s,;>"']+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) lastEmail = m[1];
    }
    return lastEmail;
  } catch {
    return null;
  }
}

export class AccountsService {
  readonly agyBin: string;
  readonly profilesRoot: string;
  readonly quotaLowPct: number;
  readonly quotaRefreshMin: number;
  private readonly repoRoot: string;
  private readonly db: OfficeDatabase;
  private readonly orchestrator: HubOrchestrator;
  private readonly adapter: AntigravityAdapter;
  private readonly onAccountsChanged?: () => void;
  private readonly onJobUpdate?: (job: AgyJob) => void;

  private jobs = new Map<string, AgyJob>();
  private jobPromises = new Map<string, Promise<void>>();
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private isRefreshing = false;

  constructor(opts: AccountsServiceOptions) {
    this.db = opts.db;
    this.orchestrator = opts.orchestrator;
    this.agyBin =
      opts.agyBin ?? process.env.AGY_BIN ?? join(homedir(), ".gemini", "bin", "agy");
    this.profilesRoot =
      opts.profilesRoot ??
      process.env.AGENT_OFFICE_PROFILES ??
      join(homedir(), "agent-office-data", "profiles");
    const envLow = Number(process.env.QUOTA_LOW_PCT ?? 15);
    this.quotaLowPct = opts.quotaLowPct ?? (Number.isFinite(envLow) ? envLow : 15);
    const envRefresh = Number(process.env.QUOTA_REFRESH_MIN ?? 15);
    this.quotaRefreshMin = opts.quotaRefreshMin ?? (Number.isFinite(envRefresh) ? envRefresh : 15);
    this.repoRoot = opts.repoRoot ?? resolve(dirname(import.meta.dir), "..", "..");
    this.onAccountsChanged = opts.onAccountsChanged;
    this.onJobUpdate = opts.onJobUpdate;
    this.adapter = new AntigravityAdapter(this.agyBin);

    this.seedDefaults();
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    this.db.insertSlotIfNotExists({
      id: "default",
      name: "Mặc định (tài khoản hiện tại)",
      home_dir: homedir(),
      is_default: 1,
      enabled: 1,
      model: null,
      effort: "medium",
      status: "unknown",
      email: null,
      models_json: "[]",
      quota_json: "[]",
      credits: null,
      cooldown_until: null,
      last_quota_error_json: null,
      manual_json: "{}",
      last_checked_at: null,
      created_at: now,
      updated_at: now,
    });

    for (const row of SEEDED_PROVIDERS) {
      this.db.insertProviderRowIfNotExists(row);
    }
  }

  private computeStatus(
    storedStatus: string,
    cooldownUntil: string | null,
    quota: QuotaWindow[],
    lastCheckedAt: string | null
  ): SlotStatus {
    if (storedStatus === "signed_out") return "signed_out";
    if (cooldownUntil) {
      const ts = Date.parse(cooldownUntil);
      if (Number.isFinite(ts) && ts > Date.now()) {
        return "cooldown";
      }
    }
    if (!lastCheckedAt) return "unknown";
    const hasLow = quota.some(
      (w) => w.source === "provider" && w.remainingPct < this.quotaLowPct
    );
    if (hasLow) return "quota_low";
    return "ready";
  }

  private hydrateSlot(row: SlotDbRow, usage?: SlotUsageRow): Slot {
    const models = safeJsonParse<SlotModel[]>(row.models_json, []);
    const quota = safeJsonParse<QuotaWindow[]>(row.quota_json, []);
    const lastQuotaError = safeJsonParse<{ at: string; message: string } | null>(
      row.last_quota_error_json,
      null
    );
    const manual = safeJsonParse<{ limitNote?: string; resetRule?: string }>(row.manual_json, {});
    const u = usage ?? this.db.getSlotUsage(row.id);
    const isDefault = row.is_default === 1;
    const status = this.computeStatus(row.status, row.cooldown_until, quota, row.last_checked_at);

    return {
      id: row.id,
      name: row.name,
      homeDir: row.home_dir,
      isDefault,
      enabled: row.enabled === 1,
      model: row.model,
      effort: (VALID_EFFORTS.has(row.effort as SlotEffort) ? row.effort : "medium") as SlotEffort,
      status,
      email: row.email,
      models,
      quota,
      credits: row.credits,
      measured: {
        requests: u.requests,
        totalTokens: u.total_tokens,
        lastJobAt: u.last_job_at,
        source: "measured",
      },
      cooldownUntil: row.cooldown_until,
      lastQuotaError,
      manual,
      lastCheckedAt: row.last_checked_at,
      signInCommand: buildSignInCommand(row.home_dir, isDefault),
    };
  }

  private hydrateProvider(row: ProviderDbRow): ProviderRow {
    let detected: string | undefined;
    if (row.kind === "cursor") {
      detected = Bun.which("agent") ?? Bun.which("cursor-agent") ?? "Chưa cài CLI (agent/cursor-agent)";
    } else if (row.kind === "codex") {
      detected = Bun.which("codex") ?? "Chưa cài CLI (codex)";
    }
    return {
      id: row.id,
      label: row.label,
      kind: row.kind as ProviderKind,
      ...(detected !== undefined ? { detected } : {}),
      usedPct: row.used_pct,
      sharePct: row.share_pct,
      resetAt: row.reset_at,
      resetRule: row.reset_rule,
      limitNote: row.limit_note,
      note: row.note,
      source: row.source as Source | "none",
      updatedAt: row.updated_at,
    };
  }

  private emitAccountsChanged(): void {
    try {
      this.onAccountsChanged?.();
    } catch {
      // isolate callback errors
    }
  }

  private emitJobUpdate(job: AgyJob): void {
    try {
      this.onJobUpdate?.({ ...job, attempts: [...job.attempts] });
    } catch {
      // isolate callback errors
    }
  }

  getAccounts(): { slots: Slot[]; providers: ProviderRow[]; quotaLowPct: number } {
    const usageMap = this.db.listSlotUsage();
    const slots = this.db
      .listSlotRows()
      .map((row) => this.hydrateSlot(row, usageMap.get(row.id)));
    const providers = this.db.listProviderRows().map((row) => this.hydrateProvider(row));
    return { slots, providers, quotaLowPct: this.quotaLowPct };
  }

  getSlot(id: string): Slot | null {
    const row = this.db.getSlotRow(id);
    if (!row) return null;
    return this.hydrateSlot(row);
  }

  createSlot(input: { name: string }): Slot {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) {
      throw new AccountsError(400, "Slot name is required");
    }

    mkdirSync(this.profilesRoot, { recursive: true, mode: 0o700 });

    const baseSlug = slugifyName(name);
    let slug = baseSlug === "default" ? "default-2" : baseSlug;
    let counter = 2;
    while (this.db.getSlotRow(slug) || existsSync(join(this.profilesRoot, slug))) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    const homeDir = join(this.profilesRoot, slug);
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    chmodSync(homeDir, 0o700);

    const now = new Date().toISOString();
    const row: SlotDbRow = {
      id: slug,
      name,
      home_dir: homeDir,
      is_default: 0,
      enabled: 1,
      model: null,
      effort: "medium",
      status: "unknown",
      email: null,
      models_json: "[]",
      quota_json: "[]",
      credits: null,
      cooldown_until: null,
      last_quota_error_json: null,
      manual_json: "{}",
      last_checked_at: null,
      created_at: now,
      updated_at: now,
    };
    this.db.upsertSlotRow(row);
    this.emitAccountsChanged();
    return this.hydrateSlot(row);
  }

  patchSlot(
    id: string,
    patch: {
      name?: string;
      model?: string | null;
      effort?: SlotEffort;
      enabled?: boolean;
      manual?: { limitNote?: string; resetRule?: string };
    }
  ): Slot {
    const row = this.db.getSlotRow(id);
    if (!row) throw new AccountsError(404, `Slot not found: ${id}`);

    const models = safeJsonParse<SlotModel[]>(row.models_json, []);

    if (patch.name !== undefined) {
      if (typeof patch.name !== "string" || !patch.name.trim()) {
        throw new AccountsError(400, "Slot name must be a non-empty string");
      }
      row.name = patch.name.trim();
    }

    if (patch.model !== undefined) {
      if (patch.model === null || patch.model === "") {
        row.model = null;
      } else if (typeof patch.model === "string") {
        if (models.length > 0 && !models.some((m) => m.id === patch.model)) {
          throw new AccountsError(400, `Model "${patch.model}" is not in slot's available models`);
        }
        row.model = patch.model;
      } else {
        throw new AccountsError(400, "Invalid model");
      }
    }

    if (patch.effort !== undefined) {
      if (!VALID_EFFORTS.has(patch.effort)) {
        throw new AccountsError(400, `Invalid effort: ${String(patch.effort)}`);
      }
      row.effort = patch.effort;
    }

    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") {
        throw new AccountsError(400, "enabled must be boolean");
      }
      row.enabled = patch.enabled ? 1 : 0;
    }

    if (patch.manual !== undefined) {
      if (!patch.manual || typeof patch.manual !== "object") {
        throw new AccountsError(400, "manual must be an object");
      }
      const prevManual = safeJsonParse<{ limitNote?: string; resetRule?: string }>(
        row.manual_json,
        {}
      );
      const nextManual: { limitNote?: string; resetRule?: string } = { ...prevManual };
      if (patch.manual.limitNote !== undefined) nextManual.limitNote = patch.manual.limitNote;
      if (patch.manual.resetRule !== undefined) nextManual.resetRule = patch.manual.resetRule;
      row.manual_json = JSON.stringify(nextManual);
    }

    row.updated_at = new Date().toISOString();
    this.db.upsertSlotRow(row);
    this.emitAccountsChanged();
    return this.hydrateSlot(row);
  }

  deleteSlot(id: string, purge = false): { ok: true } {
    const row = this.db.getSlotRow(id);
    if (!row) throw new AccountsError(404, `Slot not found: ${id}`);
    if (row.is_default === 1) {
      throw new AccountsError(400, "Default slot cannot be deleted");
    }

    this.db.deleteSlotRow(id);

    if (purge) {
      const resolvedRoot = resolve(this.profilesRoot);
      const resolvedHome = resolve(row.home_dir);
      if (resolvedHome !== resolvedRoot && resolvedHome.startsWith(`${resolvedRoot}${sep}`)) {
        try {
          rmSync(resolvedHome, { recursive: true, force: true });
        } catch {
          // ignore filesystem cleanup failure
        }
      }
    }

    this.emitAccountsChanged();
    return { ok: true };
  }

  private async runAgyCommand(
    slotRow: SlotDbRow,
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    const env: Record<string, string | undefined> =
      slotRow.is_default === 1
        ? { ...process.env }
        : { ...process.env, HOME: slotRow.home_dir };

    const proc = Bun.spawn([this.agyBin, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, AGY_CMD_TIMEOUT_MS);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }

  async checkSlot(id: string): Promise<Slot> {
    const row = this.db.getSlotRow(id);
    if (!row) throw new AccountsError(404, `Slot not found: ${id}`);

    const now = new Date().toISOString();
    const modelsRes = await this.runAgyCommand(row, ["models"]);
    const combinedModelsErr = `${modelsRes.stderr}\n${modelsRes.stdout}`;

    const isSignedOut =
      modelsRes.exitCode !== 0 && /please sign in|sign in/i.test(combinedModelsErr);

    if (isSignedOut) {
      row.status = "signed_out";
      row.models_json = "[]";
      row.quota_json = "[]";
      row.credits = null;
      row.last_checked_at = now;
      row.updated_at = now;
      this.db.upsertSlotRow(row);
      this.emitAccountsChanged();
      return this.hydrateSlot(row);
    }

    const models = modelsRes.exitCode === 0 ? parseModelsOutput(modelsRes.stdout) : [];
    const quotaRes = await this.runAgyCommand(row, ["--print=/quota"]);
    const quota = quotaRes.exitCode === 0 ? parseQuotaOutput(quotaRes.stdout, now) : [];
    const creditsRes = await this.runAgyCommand(row, ["--print=/credits"]);
    const credits = creditsRes.exitCode === 0 ? parseCreditsOutput(creditsRes.stdout) : null;
    const email = readEmailFromCliLog(row.home_dir);

    row.models_json = JSON.stringify(models);
    row.quota_json = JSON.stringify(quota);
    row.credits = credits;
    row.email = email;
    row.last_checked_at = now;
    row.status = this.computeStatus("ready", row.cooldown_until, quota, now);
    row.updated_at = now;

    this.db.upsertSlotRow(row);
    this.emitAccountsChanged();
    return this.hydrateSlot(row);
  }

  signInSlot(id: string, openTerminal = false): { command: string; opened: boolean } {
    const row = this.db.getSlotRow(id);
    if (!row) throw new AccountsError(404, `Slot not found: ${id}`);

    const command = buildSignInCommand(row.home_dir, row.is_default === 1);
    if (!openTerminal || process.platform !== "darwin") {
      return { command, opened: false };
    }

    const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      const proc = Bun.spawnSync(
        [
          "osascript",
          "-e",
          `tell application "Terminal" to do script "${escaped}"`,
          "-e",
          'tell application "Terminal" to activate',
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      return { command, opened: proc.exitCode === 0 };
    } catch {
      return { command, opened: false };
    }
  }

  patchProvider(
    id: string,
    patch: {
      usedPct?: number | null;
      sharePct?: number | null;
      resetAt?: string | null;
      resetRule?: string | null;
      limitNote?: string | null;
      note?: string | null;
      source?: "manual" | "provider_snapshot";
    }
  ): ProviderRow {
    const row = this.db.getProviderRow(id);
    if (!row) throw new AccountsError(404, `Provider row not found: ${id}`);

    const checkPct = (val: number | null | undefined, field: string) => {
      if (val === undefined || val === null) return;
      if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 100) {
        throw new AccountsError(400, `${field} must be a number between 0 and 100`);
      }
    };

    checkPct(patch.usedPct, "usedPct");
    checkPct(patch.sharePct, "sharePct");

    if (
      patch.source !== undefined &&
      patch.source !== "manual" &&
      patch.source !== "provider_snapshot"
    ) {
      throw new AccountsError(400, 'source must be "manual" or "provider_snapshot"');
    }

    if (patch.usedPct !== undefined) row.used_pct = patch.usedPct;
    if (patch.sharePct !== undefined) row.share_pct = patch.sharePct;
    if (patch.resetAt !== undefined) row.reset_at = patch.resetAt;
    if (patch.resetRule !== undefined) row.reset_rule = patch.resetRule;
    if (patch.limitNote !== undefined) row.limit_note = patch.limitNote;
    if (patch.note !== undefined) row.note = patch.note;
    row.source = patch.source ?? (row.source === "none" ? "manual" : row.source);
    row.updated_at = new Date().toISOString();

    this.db.updateProviderRow(row);
    this.emitAccountsChanged();
    return this.hydrateProvider(row);
  }

  startScheduler(): void {
    if (this.quotaRefreshMin <= 0) return;
    if (this.initialTimer || this.intervalTimer) return;

    const runSequentialRefresh = async () => {
      if (this.isRefreshing) return;
      this.isRefreshing = true;
      try {
        const enabled = this.db.listSlotRows().filter((r) => r.enabled === 1);
        for (const slot of enabled) {
          try {
            await this.checkSlot(slot.id);
          } catch {
            // isolate per-slot check errors
          }
        }
      } finally {
        this.isRefreshing = false;
      }
    };

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void runSequentialRefresh();
      this.intervalTimer = setInterval(() => {
        void runSequentialRefresh();
      }, this.quotaRefreshMin * 60_000);
      this.intervalTimer.unref?.();
    }, 15_000);
    this.initialTimer.unref?.();
  }

  stopScheduler(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private validateJobCwd(cwdInput: string): string {
    if (typeof cwdInput !== "string" || !cwdInput.trim()) {
      throw new AccountsError(400, "cwd is required");
    }
    const resolved = resolve(cwdInput.trim());
    if (!existsSync(resolved)) {
      throw new AccountsError(400, `cwd does not exist: ${resolved}`);
    }
    let realCwd: string;
    try {
      realCwd = realpathSync(resolved);
    } catch {
      throw new AccountsError(400, `Invalid cwd: ${resolved}`);
    }

    const allowedRoots = [
      this.repoRoot,
      join(homedir(), "agent-office-data", "worktrees"),
      join(getDataDir(), "worktrees"),
    ]
      .filter(Boolean)
      .map((r) => {
        try {
          return existsSync(r) ? realpathSync(r) : resolve(r);
        } catch {
          return resolve(r);
        }
      });

    const ok = allowedRoots.some(
      (root) => realCwd === root || realCwd.startsWith(`${root}${sep}`)
    );
    if (!ok) {
      throw new AccountsError(
        400,
        "cwd must resolve inside the repo root or ~/agent-office-data/worktrees"
      );
    }
    return realCwd;
  }

  private pickNextEligibleSlot(excludeIds: Set<string>): Slot | null {
    const usageMap = this.db.listSlotUsage();
    const candidates = this.db
      .listSlotRows()
      .map((r) => this.hydrateSlot(r, usageMap.get(r.id)))
      .filter((s) => s.enabled && !excludeIds.has(s.id));

    const minPct = (s: Slot): number =>
      s.quota.length > 0 ? Math.min(...s.quota.map((q) => q.remainingPct)) : 100;

    const sortPool = (list: Slot[]) =>
      list.sort((a, b) => {
        const pctDiff = minPct(b) - minPct(a);
        if (pctDiff !== 0) return pctDiff;
        return a.measured.requests - b.measured.requests;
      });

    const ready = sortPool(candidates.filter((s) => s.status === "ready"));
    if (ready.length > 0) return ready[0];

    const low = sortPool(candidates.filter((s) => s.status === "quota_low"));
    if (low.length > 0) return low[0];

    return null;
  }

  private computeCooldownUntil(errorText: string | undefined, slot: Slot): string {
    if (errorText) {
      const m = errorText.match(ISO_TIMESTAMP_RE);
      if (m?.[0] && Number.isFinite(Date.parse(m[0]))) {
        return m[0];
      }
    }

    const exhaustedWindows = slot.quota
      .filter((w) => w.remainingPct <= 1 && Number.isFinite(Date.parse(w.resetAt)))
      .sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt));
    if (exhaustedWindows.length > 0) {
      return exhaustedWindows[0].resetAt;
    }

    return new Date(Date.now() + 30 * 60_000).toISOString();
  }

  private rememberJob(job: AgyJob): void {
    this.jobs.set(job.id, job);
    while (this.jobs.size > MAX_JOBS_IN_MEMORY) {
      const oldestKey = this.jobs.keys().next().value;
      if (!oldestKey) break;
      this.jobs.delete(oldestKey);
      this.jobPromises.delete(oldestKey);
    }
  }

  getJob(id: string): AgyJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return { ...job, attempts: [...job.attempts] };
  }

  async waitForJob(id: string): Promise<AgyJob | null> {
    const p = this.jobPromises.get(id);
    if (p) await p;
    return this.getJob(id);
  }

  createJob(input: CreateAgyJobInput): { jobId: string; slotId: string } {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) {
      throw new AccountsError(400, "prompt is required");
    }
    const resolvedCwd = this.validateJobCwd(input.cwd);
    if (input.effort !== undefined && !VALID_EFFORTS.has(input.effort)) {
      throw new AccountsError(400, `Invalid effort: ${String(input.effort)}`);
    }

    let initialSlot: Slot | null = null;
    if (input.slotId) {
      const explicit = this.getSlot(input.slotId);
      if (!explicit) throw new AccountsError(404, `Slot not found: ${input.slotId}`);
      if (!explicit.enabled) throw new AccountsError(400, `Slot is disabled: ${input.slotId}`);
      if (explicit.status === "signed_out") {
        throw new AccountsError(400, `Slot is signed out: ${input.slotId}`);
      }
      initialSlot = explicit;
    } else {
      initialSlot = this.pickNextEligibleSlot(new Set());
      if (!initialSlot) {
        throw new AccountsError(400, "No eligible Antigravity slot available");
      }
    }

    const jobId = `agy-job-${crypto.randomUUID().slice(0, 8)}`;
    const job: AgyJob = {
      id: jobId,
      status: "queued",
      slotId: initialSlot.id,
      attempts: [],
    };
    this.rememberJob(job);
    this.emitJobUpdate(job);

    const runPromise = this.executeJob(job, initialSlot, {
      prompt,
      cwd: resolvedCwd,
      model: input.model,
      effort: input.effort,
      autoEdit: Boolean(input.autoEdit),
    });
    this.jobPromises.set(jobId, runPromise);
    runPromise.finally(() => {
      // keep job in memory; promise already resolved
    });

    return { jobId, slotId: initialSlot.id };
  }

  private async executeJob(
    job: AgyJob,
    initialSlot: Slot,
    opts: {
      prompt: string;
      cwd: string;
      model?: string;
      effort?: SlotEffort;
      autoEdit: boolean;
    }
  ): Promise<void> {
    if (opts.autoEdit) {
      job.status = "waiting_approval";
      this.emitJobUpdate(job);

      const { decision } = this.orchestrator.requestApproval({
        taskId: job.id,
        agentId: `antigravity-${initialSlot.id}`,
        provider: "antigravity",
        action: `agy job ${job.id} wants to edit files in ${opts.cwd}`,
        detail: `autoEdit requested for slot ${initialSlot.id}`,
      });
      const approved = await decision;
      if (!approved) {
        job.status = "error";
        job.error = "Approval denied";
        job.attempts.push({ slotId: initialSlot.id, outcome: "denied" });
        this.emitJobUpdate(job);
        return;
      }
    }

    const triedSlots = new Set<string>();
    let currentSlot: Slot | null = initialSlot;

    while (currentSlot) {
      triedSlots.add(currentSlot.id);
      job.slotId = currentSlot.id;
      job.status = "running";
      this.emitJobUpdate(job);

      const effectiveModel = opts.model ?? currentSlot.model ?? undefined;
      const effectiveEffort = opts.effort ?? currentSlot.effort ?? "medium";
      const sessionId = `${job.id}-${currentSlot.id}`;

      this.orchestrator.registerSession({
        sessionId,
        taskId: job.id,
        agentId: `antigravity-${currentSlot.id}`,
        adapter: this.adapter,
      });

      let result;
      try {
        result = await this.adapter.runTurn({
          taskId: job.id,
          prompt: opts.prompt,
          cwd: opts.cwd,
          bin: this.agyBin,
          model: effectiveModel,
          effort: effectiveEffort,
          sandbox: true,
          mode: opts.autoEdit ? undefined : "plan",
          dangerouslySkipPermissions: opts.autoEdit,
          profileHomeDir: currentSlot.isDefault ? undefined : currentSlot.homeDir,
          agentId: `antigravity-${currentSlot.id}`,
          onEvent: (event) => this.orchestrator.emit(event),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        job.attempts.push({ slotId: currentSlot.id, outcome: "error" });
        job.status = "error";
        job.error = msg;
        this.emitJobUpdate(job);
        return;
      } finally {
        this.orchestrator.unregisterSession(sessionId);
      }

      const isQuotaError =
        result.agyError?.status === "RESOURCE_EXHAUSTED" ||
        QUOTA_ERROR_RE.test(result.errorText ?? "");

      if (result.exitCode === 0 && !isQuotaError) {
        const now = new Date().toISOString();
        const totalTokens = result.usage?.total_tokens ?? 0;
        this.db.incrementSlotUsage(currentSlot.id, totalTokens, now);
        job.usage = result.usage;
        job.attempts.push({ slotId: currentSlot.id, outcome: "done" });
        job.status = "done";
        this.emitAccountsChanged();
        this.emitJobUpdate(job);
        return;
      }

      if (isQuotaError) {
        const now = new Date().toISOString();
        const cooldownUntil = this.computeCooldownUntil(result.errorText, currentSlot);
        const row = this.db.getSlotRow(currentSlot.id);
        if (row) {
          row.cooldown_until = cooldownUntil;
          row.last_quota_error_json = JSON.stringify({
            at: now,
            message: (result.errorText ?? "RESOURCE_EXHAUSTED").slice(0, 500),
          });
          row.status = "cooldown";
          row.updated_at = now;
          this.db.upsertSlotRow(row);
        }
        this.emitAccountsChanged();
        job.attempts.push({ slotId: currentSlot.id, outcome: "quota_exhausted" });

        const nextSlot = this.pickNextEligibleSlot(triedSlots);
        if (nextSlot) {
          currentSlot = nextSlot;
          continue;
        }

        job.status = "error";
        job.error = result.errorText ?? "All eligible slots exhausted";
        this.emitJobUpdate(job);
        return;
      }

      job.attempts.push({ slotId: currentSlot.id, outcome: "error" });
      job.status = "error";
      job.error = result.errorText ?? `Exited with code ${result.exitCode}`;
      this.emitJobUpdate(job);
      return;
    }
  }

  async runPinnedTurn(input: PinnedTurnInput): Promise<PinnedTurnResult> {
    const slotId = input.slotId?.trim() || "default";
    const row = this.db.getSlotRow(slotId);
    if (!row) {
      return { ok: false, slotId, text: "", error: `Slot not found: ${slotId}` };
    }
    const slot = this.hydrateSlot(row);
    if (!slot.enabled) {
      return { ok: false, slotId, text: "", error: `Slot is disabled: ${slotId}` };
    }
    if (slot.status === "signed_out") {
      return { ok: false, slotId, text: "", error: `Slot is signed out: ${slotId}` };
    }

    const effectiveEffort: SlotEffort =
      input.effort && VALID_EFFORTS.has(input.effort) ? input.effort : slot.effort ?? "low";
    const effectiveModel = input.model ?? slot.model ?? undefined;
    const printTimeout = input.printTimeout ?? "120s";
    const cwd = input.cwd ?? this.repoRoot;
    const agentId = input.agentId ?? `antigravity-${slot.id}`;
    const taskId = input.taskId ?? `turn-${crypto.randomUUID().slice(0, 8)}`;

    const args = [
      `--print=${input.prompt}`,
      "--output-format",
      "stream-json",
      "--mode",
      "plan",
      "--effort",
      effectiveEffort,
      "--print-timeout",
      printTimeout,
      "--sandbox",
    ];
    if (effectiveModel) args.push("--model", effectiveModel);

    const env: Record<string, string | undefined> =
      row.is_default === 1 ? { ...process.env } : { ...process.env, HOME: row.home_dir };

    this.orchestrator.emit({
      id: crypto.randomUUID(),
      ts: Date.now(),
      agentId,
      provider: "antigravity",
      taskId,
      status: "thinking",
      summary: `Meeting turn started (slot=${slot.id}, effort=${effectiveEffort})`,
    });

    const proc = Bun.spawn([this.agyBin, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, 125_000);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      let usage: AgyUsage | undefined;
      const textParts: string[] = [];
      const errorLines: string[] = [];

      const extractUsageFromObj = (rec: Record<string, unknown>): AgyUsage | undefined => {
        const raw =
          (rec.usage && typeof rec.usage === "object"
            ? (rec.usage as Record<string, unknown>)
            : null) ??
          (rec.result &&
          typeof rec.result === "object" &&
          (rec.result as Record<string, unknown>).usage
            ? ((rec.result as Record<string, unknown>).usage as Record<string, unknown>)
            : null);
        if (!raw) return undefined;
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
        const input_tokens = num(raw.input_tokens);
        const output_tokens = num(raw.output_tokens);
        const thinking_tokens = num(raw.thinking_tokens);
        const cache_read_tokens = num(raw.cache_read_tokens);
        const total_tokens =
          num(raw.total_tokens) ??
          (input_tokens !== undefined || output_tokens !== undefined
            ? (input_tokens ?? 0) + (output_tokens ?? 0) + (thinking_tokens ?? 0)
            : undefined);
        if (
          input_tokens === undefined &&
          output_tokens === undefined &&
          thinking_tokens === undefined &&
          cache_read_tokens === undefined &&
          total_tokens === undefined
        ) {
          return undefined;
        }
        return { input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens };
      };

      for (const rawLine of stdout.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.includes("AGY_ERROR:")) {
          errorLines.push(line);
          continue;
        }
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const u = extractUsageFromObj(parsed);
          if (u) usage = u;

          const res =
            parsed.result && typeof parsed.result === "object"
              ? (parsed.result as Record<string, unknown>)
              : null;
          // agy 1.5 stream-json puts the final answer in result.response.
          if (res && typeof res.response === "string" && res.response.trim()) {
            textParts.push(res.response.trim());
          } else if (res && typeof res.text === "string" && res.text.trim()) {
            textParts.push(res.text.trim());
          } else if (res && typeof res.output === "string" && res.output.trim()) {
            textParts.push(res.output.trim());
          } else if (res && typeof res.message === "string" && res.message.trim()) {
            textParts.push(res.message.trim());
          } else if (typeof parsed.text === "string" && parsed.text.trim()) {
            textParts.push(parsed.text.trim());
          } else if (typeof parsed.delta === "string" && parsed.delta.trim()) {
            textParts.push(parsed.delta.trim());
          } else if (typeof parsed.content === "string" && parsed.content.trim()) {
            textParts.push(parsed.content.trim());
          } else if (
            parsed.message &&
            typeof parsed.message === "object" &&
            typeof (parsed.message as Record<string, unknown>).content === "string"
          ) {
            const c = String((parsed.message as Record<string, unknown>).content).trim();
            if (c) textParts.push(c);
          }
          if (parsed.type === "error" || parsed.error) {
            errorLines.push(
              typeof parsed.error === "string"
                ? parsed.error
                : typeof parsed.message === "string"
                  ? parsed.message
                  : line
            );
          }
        } catch {
          textParts.push(line);
        }
      }

      for (const sLine of stderr.split("\n")) {
        const t = sLine.trim();
        if (t) errorLines.push(t);
      }

      const errorText = timedOut
        ? `Timed out after ${printTimeout}`
        : errorLines.length > 0
          ? errorLines.join("\n")
          : undefined;
      const isQuotaError = Boolean(errorText && QUOTA_ERROR_RE.test(errorText));

      if (exitCode === 0 && !isQuotaError && !timedOut) {
        const now = new Date().toISOString();
        const totalTokens = usage?.total_tokens ?? 0;
        this.db.incrementSlotUsage(slot.id, totalTokens, now);
        this.emitAccountsChanged();
        this.orchestrator.emit({
          id: crypto.randomUUID(),
          ts: Date.now(),
          agentId,
          provider: "antigravity",
          taskId,
          status: "completed",
          summary: "Meeting turn completed",
        });
        return {
          ok: true,
          slotId: slot.id,
          text: textParts.join("\n").trim(),
          usage,
        };
      }

      if (isQuotaError) {
        const now = new Date().toISOString();
        const cooldownUntil = this.computeCooldownUntil(errorText, slot);
        const latestRow = this.db.getSlotRow(slot.id);
        if (latestRow) {
          latestRow.cooldown_until = cooldownUntil;
          latestRow.last_quota_error_json = JSON.stringify({
            at: now,
            message: (errorText ?? "RESOURCE_EXHAUSTED").slice(0, 500),
          });
          latestRow.status = "cooldown";
          latestRow.updated_at = now;
          this.db.upsertSlotRow(latestRow);
        }
        this.emitAccountsChanged();
      }

      this.orchestrator.emit({
        id: crypto.randomUUID(),
        ts: Date.now(),
        agentId,
        provider: "antigravity",
        taskId,
        status: "error",
        summary: errorText ?? `Exited with code ${exitCode}`,
      });

      return {
        ok: false,
        slotId: slot.id,
        text: textParts.join("\n").trim(),
        usage,
        error: errorText ?? `Exited with code ${exitCode}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
