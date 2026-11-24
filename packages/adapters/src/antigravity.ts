import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentEvent, DiscoveredAgent } from "../../protocol/src/events.ts";

export type AgyEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyErrorInfo {
  short_error?: string;
  status?: string;
  retryable?: boolean;
  reason?: string;
  raw: string;
}

export interface AgyRunOptions {
  taskId: string;
  prompt: string;
  cwd: string;
  effort?: AgyEffort;
  model?: string;
  conversationId?: string;
  sandbox?: boolean;
  mode?: string;
  dangerouslySkipPermissions?: boolean;
  bin?: string;
  env?: Record<string, string | undefined>;
  profileHomeDir?: string;
  agentId?: string;
  onEvent: (event: AgentEvent) => void;
}

export interface AgyRunResult {
  exitCode: number;
  sessionId: string;
  usage?: AgyUsage;
  errorText?: string;
  agyError?: AgyErrorInfo;
}

function parseAgyErrorLine(line: string): AgyErrorInfo | undefined {
  const idx = line.indexOf("AGY_ERROR:");
  if (idx === -1) return undefined;
  const rawJson = line.slice(idx + "AGY_ERROR:".length).trim();
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    return {
      short_error: typeof parsed.short_error === "string" ? parsed.short_error : undefined,
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      raw: line,
    };
  } catch {
    return { raw: line };
  }
}

function extractUsage(obj: unknown): AgyUsage | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  const u =
    (rec.usage && typeof rec.usage === "object" ? (rec.usage as Record<string, unknown>) : null) ??
    (rec.result && typeof rec.result === "object" && (rec.result as Record<string, unknown>).usage
      ? ((rec.result as Record<string, unknown>).usage as Record<string, unknown>)
      : null);
  if (!u) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input_tokens = num(u.input_tokens);
  const output_tokens = num(u.output_tokens);
  const thinking_tokens = num(u.thinking_tokens);
  const cache_read_tokens = num(u.cache_read_tokens);
  const total_tokens =
    num(u.total_tokens) ??
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
}

export class AntigravityAdapter implements AgentAdapter {
  readonly provider = "antigravity" as const;
  private activeProcs = new Map<string, ReturnType<typeof Bun.spawn>>();

  constructor(private readonly defaultBin?: string) {}

  resolveBinary(override?: string): string | undefined {
    const candidates = [
      override ?? "",
      this.defaultBin ?? "",
      process.env.AGY_BIN ?? "",
      Bun.which("agy") ?? "",
      join(homedir(), ".gemini", "bin", "agy"),
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        // skip broken links
      }
    }
    return undefined;
  }

  async discover(): Promise<DiscoveredAgent[]> {
    const bin = this.resolveBinary();
    return [
      {
        id: "antigravity-default",
        provider: "antigravity",
        displayName: "Antigravity CLI",
        binaryPath: bin,
        configPath: join(homedir(), ".gemini"),
        ready: Boolean(bin),
        reason: bin ? "Ready (stream-json headless supported)" : "agy binary not found",
      },
    ];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const bin = this.resolveBinary();
    if (!bin) return { ok: false, detail: "agy binary not found" };
    const proc = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    return {
      ok: proc.exitCode === 0,
      detail: proc.stdout.toString().trim() || proc.stderr.toString().trim(),
    };
  }

  async runTurn(opts: AgyRunOptions): Promise<AgyRunResult> {
    const bin = this.resolveBinary(opts.bin);
    if (!bin) throw new Error("Antigravity CLI (agy) not found");

    const agentId = opts.agentId ?? "antigravity-default";
    const sessionId = opts.conversationId ?? `agy-${opts.taskId}-${Date.now()}`;
    const args = [
      `--print=${opts.prompt}`,
      "--output-format",
      "stream-json",
      "--effort",
      opts.effort ?? "low",
    ];
    if (opts.sandbox !== false) args.push("--sandbox");
    if (opts.mode) args.push("--mode", opts.mode);
    if (opts.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (opts.model) args.push("--model", opts.model);
    if (opts.conversationId) args.push("--conversation", opts.conversationId);

    const env: Record<string, string | undefined> = opts.env
      ? { ...process.env, ...opts.env }
      : { ...process.env };
    if (opts.profileHomeDir) {
      env.HOME = opts.profileHomeDir;
    }

    opts.onEvent({
      id: crypto.randomUUID(),
      ts: Date.now(),
      agentId,
      provider: "antigravity",
      taskId: opts.taskId,
      status: "thinking",
      summary: `Antigravity started (effort=${opts.effort ?? "low"})`,
    });

    const proc = Bun.spawn([bin, ...args], {
      cwd: opts.cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.activeProcs.set(sessionId, proc);

    const reader = proc.stdout.getReader();
    const stderrPromise = new Response(proc.stderr).text();
    const decoder = new TextDecoder();
    let buffer = "";
    let toolCalls = 0;
    let usage: AgyUsage | undefined;
    let agyError: AgyErrorInfo | undefined;
    const errorLines: string[] = [];

    const handleLine = (trimmed: string) => {
      if (!trimmed) return;
      const errParsed = parseAgyErrorLine(trimmed);
      if (errParsed) {
        agyError = errParsed;
        errorLines.push(trimmed);
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const type = String(parsed.type ?? "");
        const extracted = extractUsage(parsed);
        if (extracted) usage = extracted;
        if (type.includes("tool")) {
          toolCalls += 1;
          opts.onEvent({
            id: crypto.randomUUID(),
            ts: Date.now(),
            agentId,
            provider: "antigravity",
            taskId: opts.taskId,
            status: "calling_tool",
            toolName: String(parsed.tool ?? parsed.name ?? "tool"),
            summary: `Calling ${String(parsed.tool ?? parsed.name ?? "tool")}`,
            telemetry: { toolCallCount: toolCalls, repeatedActionCount: 0 },
          });
        } else if (type === "error" || parsed.error) {
          const msg =
            typeof parsed.error === "string"
              ? parsed.error
              : typeof parsed.message === "string"
                ? parsed.message
                : trimmed;
          errorLines.push(msg);
        }
      } catch {
        // ignore non-JSON progress lines
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line.trim());
        }
      }
      if (buffer.trim()) {
        handleLine(buffer.trim());
      }
      const [exitCode, stderrText] = await Promise.all([proc.exited, stderrPromise]);
      for (const sLine of stderrText.split("\n")) {
        const t = sLine.trim();
        if (!t) continue;
        const errParsed = parseAgyErrorLine(t);
        if (errParsed) agyError = errParsed;
        errorLines.push(t);
      }

      const errorText = errorLines.length > 0 ? errorLines.join("\n") : undefined;
      const hasError = exitCode !== 0 || Boolean(agyError);

      opts.onEvent({
        id: crypto.randomUUID(),
        ts: Date.now(),
        agentId,
        provider: "antigravity",
        taskId: opts.taskId,
        status: !hasError ? "completed" : "error",
        summary: !hasError
          ? "Turn completed"
          : agyError?.short_error ?? `Exited with code ${exitCode}`,
        telemetry: { toolCallCount: toolCalls, repeatedActionCount: 0 },
      });
      return { exitCode, sessionId, usage, errorText, agyError };
    } finally {
      this.activeProcs.delete(sessionId);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const proc = this.activeProcs.get(sessionId);
    if (proc) {
      proc.kill("SIGTERM");
      this.activeProcs.delete(sessionId);
    }
  }
}
