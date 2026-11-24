import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentEvent, DiscoveredAgent } from "../../protocol/src/events.ts";

export interface CodexRunOptions {
  taskId: string;
  prompt: string;
  cwd: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write";
  onEvent: (event: AgentEvent) => void;
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex" as const;
  private activeProcs = new Map<string, ReturnType<typeof Bun.spawn>>();

  resolveBinary(): string | undefined {
    const candidates = [
      Bun.which("codex") ?? "",
      join(homedir(), ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ].filter(Boolean);
    for (const p of candidates) {
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        // skip
      }
    }
    return undefined;
  }

  async discover(): Promise<DiscoveredAgent[]> {
    const bin = this.resolveBinary();
    const configDir = join(homedir(), ".codex");
    return [
      {
        id: "codex-default",
        provider: "codex",
        displayName: "OpenAI Codex CLI",
        binaryPath: bin,
        configPath: existsSync(configDir) ? configDir : undefined,
        ready: Boolean(bin),
        reason: bin
          ? "Ready (codex exec --json / app-server)"
          : "Codex CLI ('codex') not found in PATH yet",
      },
    ];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const bin = this.resolveBinary();
    if (!bin) return { ok: false, detail: "codex CLI not installed in PATH" };
    const proc = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    return {
      ok: proc.exitCode === 0,
      detail: proc.stdout.toString().trim() || proc.stderr.toString().trim(),
    };
  }

  async runTurn(opts: CodexRunOptions): Promise<{ exitCode: number; sessionId: string }> {
    const bin = this.resolveBinary();
    if (!bin) throw new Error("Codex CLI ('codex') not found in PATH");

    const sessionId = `codex-${opts.taskId}-${Date.now()}`;
    const args = [
      "exec",
      "--json",
      "--sandbox",
      opts.sandbox ?? "workspace-write",
      opts.prompt,
    ];
    if (opts.model) args.splice(2, 0, "--model", opts.model);

    opts.onEvent({
      id: crypto.randomUUID(),
      ts: Date.now(),
      agentId: "codex-default",
      provider: "codex",
      taskId: opts.taskId,
      status: "thinking",
      summary: "Codex CLI started",
    });

    const proc = Bun.spawn([bin, ...args], {
      cwd: opts.cwd,
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
            if (type.startsWith("item.")) {
              toolCalls += 1;
              opts.onEvent({
                id: crypto.randomUUID(),
                ts: Date.now(),
                agentId: "codex-default",
                provider: "codex",
                taskId: opts.taskId,
                status: "calling_tool",
                toolName: type,
                summary: `Codex ${type}`,
                telemetry: { toolCallCount: toolCalls, repeatedActionCount: 0 },
              });
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      }
      const exitCode = await proc.exited;
      opts.onEvent({
        id: crypto.randomUUID(),
        ts: Date.now(),
        agentId: "codex-default",
        provider: "codex",
        taskId: opts.taskId,
        status: exitCode === 0 ? "completed" : "error",
        summary: exitCode === 0 ? "Codex turn completed" : `Exited with code ${exitCode}`,
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
