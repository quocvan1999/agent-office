export type AgentProvider = "cursor" | "antigravity" | "codex" | "api";

export type AgentStatus =
  | "idle"
  | "thinking"
  | "calling_tool"
  | "waiting_approval"
  | "completed"
  | "error"
  | "stopped";

export interface TokenTelemetry {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  contextChars?: number;
  toolCallCount: number;
  repeatedActionCount: number;
}

export interface AgentEvent {
  id: string;
  ts: number;
  agentId: string;
  provider: AgentProvider;
  taskId?: string;
  status: AgentStatus;
  summary: string;
  toolName?: string;
  approvalId?: string;
  telemetry?: TokenTelemetry;
}

export interface DiscoveredAgent {
  id: string;
  provider: AgentProvider;
  displayName: string;
  binaryPath?: string;
  configPath?: string;
  ready: boolean;
  reason?: string;
}

export interface AgentAdapter {
  readonly provider: AgentProvider;
  discover(): Promise<DiscoveredAgent[]>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  abort(sessionId: string): Promise<void>;
}
