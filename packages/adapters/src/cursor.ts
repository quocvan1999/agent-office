import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentEvent, DiscoveredAgent } from "../../protocol/src/events.ts";

export interface CursorRunOptions {
  taskId: string;
  prompt: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  onEvent: (event: AgentEvent) => void;
  onDelta?: (text: string) => void;
}

export class CursorAdapter implements AgentAdapter {
  readonly provider = "cursor" as const;
  private activeProcs = new Map<string, ReturnType<typeof Bun.spawn>>();

  resolveBinary(): string | undefined {
    const candidates = [
      Bun.which("agent") ?? "",
      join(homedir(), ".local", "bin", "agent"),
      "/usr/local/bin/agent",
      "/opt/homebrew/bin/agent",
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
    const configDir = join(homedir(), ".cursor");
    return [
      {
        id: "cursor-default",
        provider: "cursor",
        displayName: "Cursor Agent CLI",
        binaryPath: bin,
        configPath: existsSync(configDir) ? configDir : undefined,
        ready: Boolean(bin),
        reason: bin
          ? "Ready (agent -p --output-format stream-json)"
          : "Cursor Agent CLI ('agent') not found in PATH yet",
      },
    ];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const bin = this.resolveBinary();
    if (!bin) return { ok: false, detail: "agent CLI not installed in PATH" };
    const proc = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    return {
      ok: proc.exitCode === 0,
      detail: proc.stdout.toString().trim() || proc.stderr.toString().trim(),
    };
  }

  async runTurn(opts: CursorRunOptions): Promise<{ exitCode: number; sessionId: string }> {
    const bin = this.resolveBinary();
    if (!bin) throw new Error("Cursor Agent CLI ('agent') not found in PATH");

    const sessionId = opts.sessionId ?? `cursor-${opts.taskId}-${Date.now()}`;
    const args = [
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--stream-partial-output",
    ];
    if (opts.model) args.push("--model", opts.model);

    opts.onEvent({
      id: crypto.randomUUID(),
      ts: Date.now(),
      agentId: "cursor-default",
      provider: "cursor",
      taskId: opts.taskId,
      status: "thinking",
      summary: "Cursor Agent CLI started",
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
            // Per Cursor headless docs: only append assistant deltas with timestamp_ms and no model_call_id
            if (
              parsed.type === "assistant" &&
              parsed.timestamp_ms !== undefined &&
              parsed.model_call_id === undefined
            ) {
              const msg = parsed.message as { content?: Array<{ text?: string }> } | undefined;
              const delta = msg?.content?.map((c) => c.text ?? "").join("") ?? "";
              if (delta && opts.onDelta) opts.onDelta(delta);
            } else if (parsed.type === "tool_call") {
              toolCalls += 1;
              opts.onEvent({
                id: crypto.randomUUID(),
                ts: Date.now(),
                agentId: "cursor-default",
                provider: "cursor",
                taskId: opts.taskId,
                status: "calling_tool",
                toolName: String(parsed.subtype ?? "tool"),
                summary: `Cursor tool: ${String(parsed.subtype ?? "tool")}`,
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
        agentId: "cursor-default",
        provider: "cursor",
        taskId: opts.taskId,
        status: exitCode === 0 ? "completed" : "error",
        summary: exitCode === 0 ? "Cursor turn completed" : `Exited with code ${exitCode}`,
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
