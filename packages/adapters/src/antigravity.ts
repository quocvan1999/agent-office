import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentEvent, DiscoveredAgent } from "../../protocol/src/events.ts";

export type AgyEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgyRunOptions {
  taskId: string;
  prompt: string;
  cwd: string;
  effort?: AgyEffort;
  model?: string;
  conversationId?: string;
  sandbox?: boolean;
  profileHomeDir?: string;
  onEvent: (event: AgentEvent) => void;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly provider = "antigravity" as const;
  private activeProcs = new Map<string, ReturnType<typeof Bun.spawn>>();

  resolveBinary(): string | undefined {
    const candidates = [
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

  async runTurn(opts: AgyRunOptions): Promise<{ exitCode: number; sessionId: string }> {
    const bin = this.resolveBinary();
    if (!bin) throw new Error("Antigravity CLI (agy) not found");

    const sessionId = opts.conversationId ?? `agy-${opts.taskId}-${Date.now()}`;
    const args = [
      `--print=${opts.prompt}`,
      "--output-format",
      "stream-json",
      "--effort",
      opts.effort ?? "low",
    ];
    if (opts.sandbox !== false) args.push("--sandbox");
    if (opts.model) args.push("--model", opts.model);
    if (opts.conversationId) args.push("--conversation", opts.conversationId);

    const env = { ...process.env };
    if (opts.profileHomeDir) {
      env.HOME = opts.profileHomeDir;
    }

    opts.onEvent({
      id: crypto.randomUUID(),
      ts: Date.now(),
      agentId: "antigravity-default",
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
    const decoder = new TextDecoder();
    let buffer = "";
    let toolCalls = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const type = String(parsed.type ?? "");
            if (type.includes("tool")) {
              toolCalls += 1;
              opts.onEvent({
                id: crypto.randomUUID(),
                ts: Date.now(),
                agentId: "antigravity-default",
                provider: "antigravity",
                taskId: opts.taskId,
                status: "calling_tool",
                toolName: String(parsed.tool ?? parsed.name ?? "tool"),
                summary: `Calling ${String(parsed.tool ?? parsed.name ?? "tool")}`,
                telemetry: { toolCallCount: toolCalls, repeatedActionCount: 0 },
              });
            }
          } catch {
            // ignore non-JSON progress lines
          }
        }
      }
      const exitCode = await proc.exited;
      opts.onEvent({
        id: crypto.randomUUID(),
        ts: Date.now(),
        agentId: "antigravity-default",
        provider: "antigravity",
        taskId: opts.taskId,
        status: exitCode === 0 ? "completed" : "error",
        summary: exitCode === 0 ? "Turn completed" : `Exited with code ${exitCode}`,
        telemetry: { toolCallCount: toolCalls, repeatedActionCount: 0 },
      });
      return { exitCode, sessionId };
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
