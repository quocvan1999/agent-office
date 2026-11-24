import type { AgentAdapter, AgentEvent, DiscoveredAgent } from "../../protocol/src/events.ts";

export interface OpenAICompatibleRunOptions {
  taskId: string;
  agentId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  onEvent: (event: AgentEvent) => void;
  onDelta?: (text: string) => void;
}

export class ApiModelAdapter implements AgentAdapter {
  readonly provider = "api" as const;
  private controllers = new Map<string, AbortController>();

  async discover(): Promise<DiscoveredAgent[]> {
    return [];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "OpenAI-compatible SSE client ready" };
  }

  async runTurn(opts: OpenAICompatibleRunOptions): Promise<{
    sessionId: string;
    text: string;
    inputTokens?: number;
    outputTokens?: number;
  }> {
    const sessionId = `api-${opts.taskId}-${Date.now()}`;
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);

    opts.onEvent({
      id: crypto.randomUUID(),
      ts: Date.now(),
      agentId: opts.agentId,
      provider: "api",
      taskId: opts.taskId,
      status: "thinking",
      summary: `Calling ${opts.model}`,
    });

    const messages: Array<{ role: string; content: string }> = [];
    if (opts.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
    messages.push({ role: "user", content: opts.prompt });

    try {
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`API error ${res.status}: ${await res.text()}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              if (opts.onDelta) opts.onDelta(delta);
            }
            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens;
              outputTokens = parsed.usage.completion_tokens;
            }
          } catch {
            // ignore malformed chunk
          }
        }
      }

      opts.onEvent({
        id: crypto.randomUUID(),
        ts: Date.now(),
        agentId: opts.agentId,
        provider: "api",
        taskId: opts.taskId,
        status: "completed",
        summary: `Completed (${opts.model})`,
        telemetry: {
          inputTokens,
          outputTokens,
          contextChars: opts.prompt.length + fullText.length,
          toolCallCount: 0,
          repeatedActionCount: 0,
        },
      });
      return { sessionId, text: fullText, inputTokens, outputTokens };
    } finally {
      this.controllers.delete(sessionId);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const controller = this.controllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.controllers.delete(sessionId);
    }
  }
}
