import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AntigravityAdapter,
  ApiModelAdapter,
  CodexAdapter,
  CursorAdapter,
} from "../../../packages/adapters/src/index.ts";
import type { AgentEvent } from "../../../packages/protocol/src/events.ts";
import { OfficeDatabase } from "./db.ts";
import { runDiscovery, scanKnowledgeHub } from "./discovery.ts";
import { HubOrchestrator } from "./orchestrator.ts";
import { lintKnowledgeBudget, loadPolicies, TaskGuard } from "./policy.ts";
import { SecretsVault } from "./vault.ts";
import { WorktreeManager } from "./worktree.ts";

const args = new Set(process.argv.slice(2));

if (args.has("--discover-only")) {
  console.log(JSON.stringify(runDiscovery(), null, 2));
  process.exit(0);
}

if (args.has("--verify")) {
  const policies = loadPolicies();
  const lint = lintKnowledgeBudget(policies);
  const agy = new AntigravityAdapter();
  const cursor = new CursorAdapter();
  const codex = new CodexAdapter();
  const api = new ApiModelAdapter();

  const [agyHealth, cursorHealth, codexHealth, apiHealth] = await Promise.all([
    agy.healthCheck(),
    cursor.healthCheck(),
    codex.healthCheck(),
    api.healthCheck(),
  ]);

  const db = new OfficeDatabase();
  const orchestrator = new HubOrchestrator(db);

  // 1. Verify Approval Queue + Stop All
  const { approval, decision } = orchestrator.requestApproval({
    taskId: "verify",
    agentId: "antigravity-default",
    provider: "antigravity",
    action: "self-test-approval",
    detail: "Phase 1 approval queue check",
  });
  const stopResult = await orchestrator.stopAll("Phase 1 verify cleanup");
  const approvalOutcome = await decision;

  // 2. Verify AES-256-GCM Vault on temporary file (never touching real vault)
  const tempVaultPath = join(tmpdir(), `agent-office-verify-${Date.now()}.enc`);
  let vaultOk = false;
  try {
    const vault = new SecretsVault(tempVaultPath);
    vault.unlock("verify-passphrase-123");
    vault.setSecret("test-key", "openai", "sk-test-value-not-real");
    vault.lock();

    // Ensure wrong passphrase throws
    let wrongRejected = false;
    try {
      vault.unlock("wrong-passphrase-999");
    } catch {
      wrongRejected = true;
    }

    vault.unlock("verify-passphrase-123");
    vaultOk = wrongRejected && vault.getSecret("test-key") === "sk-test-value-not-real";
    vault.lock();
  } finally {
    try {
      unlinkSync(tempVaultPath);
    } catch {
      // ignore
    }
  }

  // 3. Verify Git Worktree create + remove cleanly on this repo
  const wtMgr = new WorktreeManager();
  const repoRoot = process.cwd();
  const wt = wtMgr.createWorktree(repoRoot, `verify-${Date.now()}`);
  const wtDiff = wtMgr.getDiffStat(wt.path);
  wtMgr.removeWorktree(repoRoot, wt);

  // 4. Verify 0-token Loop Guard
  const guard = new TaskGuard(policies);
  const loopSteps = [
    guard.recordFileEdit("demo.ts").action,
    guard.recordFileEdit("demo.ts").action,
    guard.recordFileEdit("demo.ts").action,
    guard.recordFileEdit("demo.ts").action,
  ];

  const recentCount = db.listRecentEvents(5).length;
  db.close();

  const report = {
    ok:
      agyHealth.ok &&
      apiHealth.ok &&
      vaultOk &&
      approval.status === "denied" &&
      approvalOutcome === false &&
      stopResult.deniedApprovals === 1 &&
      wtDiff === "" &&
      loopSteps[2] === "warn" &&
      loopSteps[3] === "abort" &&
      recentCount >= 1,
    adapters: {
      antigravity: agyHealth,
      cursor: cursorHealth,
      codex: codexHealth,
      api: apiHealth,
    },
    vaultAes256GcmOk: vaultOk,
    worktreeIsolatedAndCleanedOk: wtDiff === "",
    approvalQueueAndStopAllOk: approvalOutcome === false && stopResult.deniedApprovals === 1,
    knowledgeLint: {
      canSync: lint.canSync,
      alwaysOnEstimatedTokens: lint.alwaysOnEstimatedTokens,
      feedbackLogLines: lint.feedbackLogLines,
      findingsCount: lint.findings.length,
    },
    loopGuardSteps: loopSteps,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

const db = new OfficeDatabase();
const orchestrator = new HubOrchestrator(db);
const vault = new SecretsVault();
const PORT = Number(process.env.AGENT_OFFICE_PORT ?? 4789);
const HOST = process.env.AGENT_OFFICE_HOST ?? "127.0.0.1";

const wsClients = new Set<{ send(data: string): void }>();
orchestrator.subscribe((event: AgentEvent) => {
  const payload = JSON.stringify({ type: "agent_event", event });
  for (const ws of wsClients) {
    ws.send(payload);
  }
});

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    const headers = {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, service: "agent-office-hub", ts: Date.now() }),
        { headers }
      );
    }

    if (url.pathname === "/api/discovery") {
      return new Response(JSON.stringify(runDiscovery(), null, 2), { headers });
    }

    if (url.pathname === "/api/knowledge/status") {
      return new Response(JSON.stringify(scanKnowledgeHub(), null, 2), { headers });
    }

    if (url.pathname === "/api/knowledge/lint") {
      return new Response(JSON.stringify(lintKnowledgeBudget(loadPolicies()), null, 2), {
        headers,
      });
    }

    if (url.pathname === "/api/policy") {
      return new Response(JSON.stringify(loadPolicies(), null, 2), { headers });
    }

    if (url.pathname === "/api/events") {
      return new Response(JSON.stringify(db.listRecentEvents(50), null, 2), { headers });
    }

    if (url.pathname === "/api/approvals" && req.method === "GET") {
      return new Response(JSON.stringify(orchestrator.listPendingApprovals(), null, 2), {
        headers,
      });
    }

    if (url.pathname.startsWith("/api/approvals/") && req.method === "POST") {
      const id = url.pathname.split("/")[3];
      const body = (await req.json().catch(() => ({}))) as { approved?: boolean };
      const resolved = orchestrator.resolveApproval(id, Boolean(body.approved));
      if (!resolved) {
        return new Response(JSON.stringify({ error: "Approval not found" }), {
          status: 404,
          headers,
        });
      }
      return new Response(JSON.stringify(resolved, null, 2), { headers });
    }

    if (url.pathname === "/api/stop-all" && req.method === "POST") {
      const result = await orchestrator.stopAll("Stopped by user from UI");
      return new Response(JSON.stringify(result, null, 2), { headers });
    }

    if (url.pathname === "/api/vault/status") {
      return new Response(
        JSON.stringify(
          {
            unlocked: vault.isUnlocked(),
            existsOnDisk: vault.existsOnDisk(),
            keys: vault.listMetadata(),
          },
          null,
          2
        ),
        { headers }
      );
    }

    return new Response(
      JSON.stringify({
        service: "agent-office-hub",
        endpoints: [
          "/health",
          "/api/discovery",
          "/api/knowledge/status",
          "/api/knowledge/lint",
          "/api/policy",
          "/api/events",
          "/api/approvals",
          "/api/stop-all",
          "/api/vault/status",
          "/ws",
        ],
      }),
      { status: 404, headers }
    );
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      ws.send(
        JSON.stringify({
          type: "hello",
          service: "agent-office-hub",
          discovery: runDiscovery(),
          knowledgeLint: lintKnowledgeBudget(loadPolicies()),
          pendingApprovals: orchestrator.listPendingApprovals(),
        })
      );
    },
    close(ws) {
      wsClients.delete(ws);
    },
    message(ws, msg) {
      if (msg === "ping") ws.send("pong");
    },
  },
});

console.log(`Agent Office Hub Daemon listening on http://${server.hostname}:${server.port}`);
