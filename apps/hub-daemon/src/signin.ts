import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AccountsError, type AccountsService } from "./accounts.ts";

export type SignInState =
  | "starting"
  | "awaiting_user"
  | "verifying"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

export interface SignInSession {
  slotId: string;
  state: SignInState;
  authUrl?: string;
  message?: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface SignInManagerOptions {
  accounts: AccountsService;
  agyBin?: string;
  ptyBridgePath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onSessionUpdate?: (session: SignInSession) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const URL_FILE_POLL_MS = 100;
const MAX_SCREEN_BUFFER_BYTES = 20 * 1024;
const CHECK_CMD_TIMEOUT_MS = 15_000;

const SENSITIVE_QUERY_RE =
  /([?&](?:state|code|code_challenge|nonce|access_token|refresh_token|id_token)=)([^&\s'"<>]+)/gi;

// Strip OSC, CSI, and 2-byte ANSI escape sequences
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_ESC_RE = /\x1b[@-Z\\-_]/g;

export function stripAnsi(input: string): string {
  return input
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_ESC_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00\x07]/g, "");
}

export function redactSensitiveText(text: string, extraSecrets?: Iterable<string>): string {
  let out = text.replace(SENSITIVE_QUERY_RE, "$1<redacted>");
  if (extraSecrets) {
    for (const secret of extraSecrets) {
      if (secret && secret.length >= 4) {
        out = out.split(secret).join("<redacted>");
      }
    }
  }
  return out;
}

function isActiveState(state: SignInState): boolean {
  return state === "starting" || state === "awaiting_user" || state === "verifying";
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function extractGoogleAuthUrl(screenBuffer: string): string | null {
  const lines = screenBuffer.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const idx = line.indexOf("https://accounts.google.com/");
    if (idx === -1) continue;

    let candidate = line.slice(idx).trim();
    const firstSpace = candidate.search(/\s/);
    if (firstSpace !== -1) {
      candidate = candidate.slice(0, firstSpace);
    }

    // Join wrapped lines that look like pure URL continuation
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = (lines[j] ?? "").trim();
      if (!next) break;
      if (/^https?:\/\//i.test(next)) break;
      if (/^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(next)) {
        candidate += next;
      } else {
        break;
      }
    }

    if (candidate.startsWith("https://accounts.google.com/") && candidate.includes("?")) {
      return candidate;
    }
  }
  return null;
}

interface InternalSession {
  session: SignInSession;
  homeDir: string;
  shimDir: string;
  urlFile: string;
  proc: ReturnType<typeof Bun.spawn> | null;
  screenBuffer: string;
  sentEnter: boolean;
  submittedCodes: Set<string>;
  checkInFlight: boolean;
  completing: boolean;
  urlPollTimer: ReturnType<typeof setInterval> | null;
  statusPollTimer: ReturnType<typeof setInterval> | null;
  quickCheckTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  cleanedUp: boolean;
}

export class SignInManager {
  private readonly accounts: AccountsService;
  private readonly agyBin: string;
  private readonly ptyBridgePath: string;
  private readonly fixedTimeoutMs?: number;
  private readonly pollIntervalMs: number;
  private readonly onSessionUpdate?: (session: SignInSession) => void;
  private readonly sessions = new Map<string, InternalSession>();

  constructor(opts: SignInManagerOptions) {
    this.accounts = opts.accounts;
    this.agyBin = opts.agyBin ?? opts.accounts.agyBin;
    this.ptyBridgePath =
      opts.ptyBridgePath ?? resolve(dirname(import.meta.dir), "scripts", "pty-bridge.py");
    this.fixedTimeoutMs = opts.timeoutMs;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onSessionUpdate = opts.onSessionUpdate;
  }

  private resolveTimeoutMs(): number {
    if (this.fixedTimeoutMs !== undefined && this.fixedTimeoutMs > 0) {
      return this.fixedTimeoutMs;
    }
    const envMs = Number(process.env.SIGNIN_TIMEOUT_MS);
    if (Number.isFinite(envMs) && envMs > 0) {
      return envMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private toPublicSession(internal: InternalSession): SignInSession {
    return { ...internal.session };
  }

  private emit(internal: InternalSession): void {
    try {
      this.onSessionUpdate?.(this.toPublicSession(internal));
    } catch {
      // isolate callback errors
    }
  }

  private cleanupResources(internal: InternalSession, killProc: boolean): void {
    if (internal.urlPollTimer) {
      clearInterval(internal.urlPollTimer);
      internal.urlPollTimer = null;
    }
    if (internal.statusPollTimer) {
      clearInterval(internal.statusPollTimer);
      internal.statusPollTimer = null;
    }
    if (internal.quickCheckTimer) {
      clearTimeout(internal.quickCheckTimer);
      internal.quickCheckTimer = null;
    }
    if (internal.timeoutTimer) {
      clearTimeout(internal.timeoutTimer);
      internal.timeoutTimer = null;
    }
    if (killProc && internal.proc) {
      try {
        internal.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      internal.proc = null;
    }
    if (!internal.cleanedUp && internal.shimDir) {
      internal.cleanedUp = true;
      try {
        rmSync(internal.shimDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  private createShimDir(): { shimDir: string; urlFile: string } {
    const shimDir = mkdtempSync(join(tmpdir(), "agent-office-signin-"));
    chmodSync(shimDir, 0o700);
    const urlFile = join(shimDir, "url.txt");
    const script = `#!/bin/sh\nprintf '%s\\n' "$1" >> ${shellSingleQuote(urlFile)}\nexit 0\n`;
    for (const name of ["open", "xdg-open"]) {
      const binPath = join(shimDir, name);
      writeFileSync(binPath, script, { mode: 0o755 });
      chmodSync(binPath, 0o755);
    }
    return { shimDir, urlFile };
  }

  private async checkModelsSignedIn(homeDir: string): Promise<boolean> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: homeDir,
    };
    const proc = Bun.spawn([this.agyBin, "models"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, CHECK_CMD_TIMEOUT_MS);

    try {
      const [, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return exitCode === 0;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private readUrlFromShimFile(urlFile: string): string | null {
    if (!existsSync(urlFile)) return null;
    try {
      const raw = readFileSync(urlFile, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (/^https?:\/\//i.test(trimmed)) {
          return trimmed;
        }
      }
    } catch {
      // ignore transient read errors
    }
    return null;
  }

  private tryCaptureUrl(internal: InternalSession): void {
    if (internal.session.state !== "starting") return;

    const fromShim = this.readUrlFromShimFile(internal.urlFile);
    const captured = fromShim ?? extractGoogleAuthUrl(internal.screenBuffer);
    if (!captured) return;

    internal.session.state = "awaiting_user";
    internal.session.authUrl = captured;
    internal.session.updatedAt = new Date().toISOString();

    if (internal.urlPollTimer) {
      clearInterval(internal.urlPollTimer);
      internal.urlPollTimer = null;
    }

    this.emit(internal);
    this.startStatusPolling(internal);
  }

  private startStatusPolling(internal: InternalSession): void {
    if (internal.statusPollTimer) return;
    internal.statusPollTimer = setInterval(() => {
      void this.pollSignedInStatus(internal);
    }, this.pollIntervalMs);
  }

  private async pollSignedInStatus(internal: InternalSession): Promise<void> {
    if (
      internal.checkInFlight ||
      (internal.session.state !== "awaiting_user" && internal.session.state !== "verifying")
    ) {
      return;
    }
    internal.checkInFlight = true;
    try {
      const signedIn = await this.checkModelsSignedIn(internal.homeDir);
      if (!signedIn) return;
      if (!isActiveState(internal.session.state)) return;
      await this.markCompleted(internal);
    } finally {
      internal.checkInFlight = false;
    }
  }

  private async markCompleted(internal: InternalSession): Promise<void> {
    if (internal.completing || !isActiveState(internal.session.state)) return;
    internal.completing = true;

    // Kill pty and clean up shim dir first
    this.cleanupResources(internal, true);

    // Refresh slot metadata (email/models/quota) before transitioning to completed
    // so observers immediately see status=ready, email, models, and quota.
    try {
      await this.accounts.checkSlot(internal.session.slotId);
    } catch {
      // slot refresh error shouldn't revert completed sign-in
    }

    internal.session.state = "completed";
    internal.session.authUrl = undefined;
    internal.session.message = undefined;
    internal.session.updatedAt = new Date().toISOString();

    this.emit(internal);
  }

  private appendScreenData(internal: InternalSession, chunkText: string): void {
    const clean = stripAnsi(chunkText);
    if (!clean) return;
    internal.screenBuffer += clean;
    if (internal.screenBuffer.length > MAX_SCREEN_BUFFER_BYTES) {
      internal.screenBuffer = internal.screenBuffer.slice(-MAX_SCREEN_BUFFER_BYTES);
    }

    if (!internal.sentEnter && /Select login method/i.test(internal.screenBuffer)) {
      internal.sentEnter = true;
      this.writeToPty(internal, "\r");
    }

    if (internal.session.state === "starting") {
      this.tryCaptureUrl(internal);
    }
  }

  private writeToPty(internal: InternalSession, data: string): void {
    const stdin = internal.proc?.stdin;
    if (!stdin || typeof stdin === "number") return;
    try {
      stdin.write(data);
      stdin.flush();
    } catch {
      // ignore broken pipe if process exited
    }
  }

  private lastSanitizedLines(internal: InternalSession, count = 5): string {
    const lines = internal.screenBuffer
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const tail = lines.slice(-count).join("\n");
    return redactSensitiveText(tail, internal.submittedCodes);
  }

  private async monitorProcess(
    internal: InternalSession,
    proc: ReturnType<typeof Bun.spawn>
  ): Promise<void> {
    const decoder = new TextDecoder();
    const readStream = async (stream: ReadableStream<Uint8Array> | number | undefined) => {
      if (!stream || typeof stream === "number") return;
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            this.appendScreenData(internal, decoder.decode(value, { stream: true }));
          }
        }
        const tail = decoder.decode();
        if (tail) this.appendScreenData(internal, tail);
      } catch {
        // ignore stream close errors
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    };

    await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited.catch(() => -1),
    ]);

    // If session already ended (completed, cancelled, timeout, failed) or is completing, stop here
    if (internal.completing || !isActiveState(internal.session.state)) {
      this.cleanupResources(internal, false);
      return;
    }

    // Check once if sign-in actually succeeded before process exited
    const signedIn = await this.checkModelsSignedIn(internal.homeDir);
    if (internal.completing || !isActiveState(internal.session.state)) {
      this.cleanupResources(internal, false);
      return;
    }

    if (signedIn) {
      await this.markCompleted(internal);
      return;
    }

    // Process exited before sign-in succeeded -> failed
    const lastLines = this.lastSanitizedLines(internal, 5);
    this.cleanupResources(internal, false);
    internal.proc = null;
    internal.session.state = "failed";
    internal.session.authUrl = undefined;
    internal.session.message = lastLines || "Tiến trình đăng nhập kết thúc trước khi hoàn tất";
    internal.session.updatedAt = new Date().toISOString();
    this.emit(internal);
  }

  getSession(slotId: string): SignInSession | null {
    const internal = this.sessions.get(slotId);
    return internal ? this.toPublicSession(internal) : null;
  }

  start(slotId: string, opts?: { force?: boolean }): SignInSession {
    const slot = this.accounts.getSlot(slotId);
    if (!slot) {
      throw new AccountsError(404, `Slot not found: ${slotId}`);
    }
    if (slot.isDefault && !opts?.force) {
      throw new AccountsError(
        400,
        "Default slot is already signed in (pass force: true to override)"
      );
    }

    // Cancel any existing active session for this slot so at most one is active per slot
    const existing = this.sessions.get(slotId);
    if (existing && isActiveState(existing.session.state)) {
      this.cleanupResources(existing, true);
      existing.session.state = "cancelled";
      existing.session.authUrl = undefined;
      existing.session.updatedAt = new Date().toISOString();
    }

    if (!slot.isDefault) {
      mkdirSync(slot.homeDir, { recursive: true, mode: 0o700 });
    }

    const { shimDir, urlFile } = this.createShimDir();
    const timeoutMs = this.resolveTimeoutMs();
    const nowMs = Date.now();
    const startedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + timeoutMs).toISOString();

    const internal: InternalSession = {
      session: {
        slotId,
        state: "starting",
        startedAt,
        updatedAt: startedAt,
        expiresAt,
      },
      homeDir: slot.homeDir,
      shimDir,
      urlFile,
      proc: null,
      screenBuffer: "",
      sentEnter: false,
      submittedCodes: new Set<string>(),
      checkInFlight: false,
      completing: false,
      urlPollTimer: null,
      statusPollTimer: null,
      quickCheckTimer: null,
      timeoutTimer: null,
      cleanedUp: false,
    };

    const basePath = process.env.PATH ?? "/usr/bin:/bin";
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: slot.homeDir,
      PATH: `${shimDir}:${basePath}`,
      TERM: "xterm-256color",
    };

    const proc = Bun.spawn(
      ["python3", this.ptyBridgePath, slot.homeDir, "--", this.agyBin],
      {
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    internal.proc = proc;
    this.sessions.set(slotId, internal);

    internal.urlPollTimer = setInterval(() => {
      this.tryCaptureUrl(internal);
    }, URL_FILE_POLL_MS);

    internal.timeoutTimer = setTimeout(() => {
      if (internal.completing || !isActiveState(internal.session.state)) return;
      this.cleanupResources(internal, true);
      internal.session.state = "timeout";
      internal.session.authUrl = undefined;
      internal.session.message = "Hết thời gian chờ đăng nhập";
      internal.session.updatedAt = new Date().toISOString();
      this.emit(internal);
    }, timeoutMs);

    this.emit(internal);
    void this.monitorProcess(internal, proc);

    return this.toPublicSession(internal);
  }

  submitCode(slotId: string, code: string): SignInSession {
    const slot = this.accounts.getSlot(slotId);
    if (!slot) {
      throw new AccountsError(404, `Slot not found: ${slotId}`);
    }
    const internal = this.sessions.get(slotId);
    if (!internal || !isActiveState(internal.session.state)) {
      throw new AccountsError(400, "No active sign-in session for this slot");
    }
    if (
      typeof code !== "string" ||
      code.length < 10 ||
      code.length > 2048 ||
      /\s/.test(code)
    ) {
      throw new AccountsError(
        400,
        "Invalid authorization code (must be 10..2048 characters with no whitespace)"
      );
    }

    internal.submittedCodes.add(code);
    this.writeToPty(internal, `${code}\r`);

    internal.session.state = "verifying";
    internal.session.updatedAt = new Date().toISOString();
    this.emit(internal);

    // Trigger a quick check soon after code submission, while keeping the 5s interval
    if (internal.quickCheckTimer) clearTimeout(internal.quickCheckTimer);
    internal.quickCheckTimer = setTimeout(() => {
      void this.pollSignedInStatus(internal);
    }, 400);

    return this.toPublicSession(internal);
  }

  cancel(slotId: string): SignInSession {
    const slot = this.accounts.getSlot(slotId);
    if (!slot) {
      throw new AccountsError(404, `Slot not found: ${slotId}`);
    }

    const internal = this.sessions.get(slotId);
    const now = new Date().toISOString();
    if (!internal) {
      return {
        slotId,
        state: "cancelled",
        startedAt: now,
        updatedAt: now,
        expiresAt: now,
      };
    }

    this.cleanupResources(internal, true);
    internal.session.state = "cancelled";
    internal.session.authUrl = undefined;
    internal.session.message = undefined;
    internal.session.updatedAt = now;
    this.emit(internal);

    return this.toPublicSession(internal);
  }

  disposeAll(): void {
    for (const internal of this.sessions.values()) {
      this.cleanupResources(internal, true);
    }
    this.sessions.clear();
  }
}
