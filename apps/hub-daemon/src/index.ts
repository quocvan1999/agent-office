import { AntigravityAdapter } from "../../../packages/adapters/src/antigravity.ts";
import { OfficeDatabase } from "./db.ts";
import { runDiscovery, scanKnowledgeHub } from "./discovery.ts";
import { lintKnowledgeBudget, loadPolicies, TaskGuard } from "./policy.ts";

const args = new Set(process.argv.slice(2));

if (args.has("--discover-only")) {
  console.log(JSON.stringify(runDiscovery(), null, 2));
  process.exit(0);
}

if (args.has("--verify")) {
  const policies = loadPolicies();
  const lint = lintKnowledgeBudget(policies);
  const agy = new AntigravityAdapter();
  const agyHealth = await agy.healthCheck();
  const db = new OfficeDatabase();

  db.recordEvent({
    id: "verify-boot-check",
    ts: Date.now(),
    agentId: "hub-daemon",
    provider: "antigravity",
    taskId: "verify",
    status: "completed",
    summary: "Phase 1 self-check passed",
  });
  const recentCount = db.listRecentEvents(5).length;
  db.close();

  // Verify 0-token Loop Guard triggers warn at 3 and abort at 4
  const guard = new TaskGuard(policies);
  const d1 = guard.recordFileEdit("demo.ts");
  const d2 = guard.recordFileEdit("demo.ts");
  const d3 = guard.recordFileEdit("demo.ts");
  const d4 = guard.recordFileEdit("demo.ts");

  const report = {
    ok: agyHealth.ok && d3.action === "warn" && d4.action === "abort" && recentCount >= 1,
    dbPath: db.dbPath,
    recentEventsStored: recentCount,
    antigravityHealth: agyHealth,
    knowledgeLint: lint,
    loopGuardCheck: { step1: d1.action, step2: d2.action, step3: d3.action, step4: d4.action },
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

const policies = loadPolicies();
const db = new OfficeDatabase();
const PORT = Number(process.env.AGENT_OFFICE_PORT ?? 4789);
const HOST = process.env.AGENT_OFFICE_HOST ?? "127.0.0.1";

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    const headers = {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    };

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
          "/ws",
        ],
      }),
      { status: 404, headers }
    );
  },
  websocket: {
    open(ws) {
      ws.send(
        JSON.stringify({
          type: "hello",
          service: "agent-office-hub",
          discovery: runDiscovery(),
          knowledgeLint: lintKnowledgeBudget(policies),
        })
      );
    },
    message(ws, msg) {
      if (msg === "ping") ws.send("pong");
    },
  },
});

console.log(`Agent Office Hub Daemon listening on http://${server.hostname}:${server.port}`);
