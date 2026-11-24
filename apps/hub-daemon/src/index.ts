import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AntigravityAdapter,
  ApiModelAdapter,
  CodexAdapter,
  CursorAdapter,
} from "../../../packages/adapters/src/index.ts";
import type { AgentEvent } from "../../../packages/protocol/src/events.ts";
import {
  AccountsError,
  AccountsService,
  type SlotEffort,
} from "./accounts.ts";
import { AuditRateLimitError, AuditService } from "./audit.ts";
import { OfficeDatabase } from "./db.ts";
import { runDiscovery, scanKnowledgeHub } from "./discovery.ts";
import { KnowledgeLibrary, LibraryError } from "./library.ts";
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

  // Create stub agy script first so --verify never spawns the real agy binary
  const tempAccRoot = join(tmpdir(), `agent-office-acc-verify-${Date.now()}`);
  const tempProfilesRoot = join(tempAccRoot, "profiles");
  const stubAgyBin = join(tempAccRoot, "agy-stub.sh");
  mkdirSync(tempProfilesRoot, { recursive: true });
  writeFileSync(
    stubAgyBin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agy 1.5.0-stub"
  exit 0
fi
if [ "$1" = "models" ]; then
  if [ -f "$HOME/.stub_signed_in" ]; then
    printf "gemini-2.5-pro\\tGemini 2.5 Pro\\nclaude-sonnet-4\\tClaude Sonnet 4\\n"
    exit 0
  else
    echo "Error: Please sign in to Antigravity" >&2
    exit 1
  fi
fi
for arg in "$@"; do
  case "$arg" in
    --print=/quota)
      printf "Gemini Models\\tWeekly Limit Remaining\\t97%%\\t2026-12-01T08:57:55Z\\n"
      printf "Claude and GPT models\\tFive Hour Limit Remaining\\t100%%\\t2026-11-24T14:17:13Z\\n"
      exit 0
      ;;
    --print=/credits)
      printf "Remaining credits\\t1250\\nUpgrade at https://example.com\\n"
      exit 0
      ;;
    --print=*)
      if [ -f "$HOME/.stub_exhausted" ]; then
        echo 'AGY_ERROR: {"short_error":"Quota exhausted until 2099-12-31T23:59:59Z","status":"RESOURCE_EXHAUSTED","retryable":false,"reason":"QUOTA_EXHAUSTED"}' >&2
        exit 1
      else
        echo '{"type":"result","result":{"usage":{"input_tokens":120,"output_tokens":80,"thinking_tokens":10,"cache_read_tokens":5,"total_tokens":215}}}'
        exit 0
      fi
      ;;
  esac
done
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(stubAgyBin, 0o755);

  const agy = new AntigravityAdapter(stubAgyBin);
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

  // 5. Verify Knowledge Library + Rule Audit on temp KNOWLEDGE_ROOT fixture (never touches real ~/.cursor)
  const tempLibRoot = join(tmpdir(), `agent-office-lib-verify-${Date.now()}`);
  const tempOutsideFile = join(tmpdir(), `agent-office-outside-${Date.now()}.txt`);
  let libTreeOk = false;
  let libWriteOk = false;
  let libEscapeRejectedOk = false;
  let libSyncSkippedOk = false;
  let auditRuleOk = false;
  try {
    mkdirSync(join(tempLibRoot, "plugins/local/lyvan-global/.cursor-plugin"), { recursive: true });
    mkdirSync(join(tempLibRoot, "plugins/local/lyvan-global/rules"), { recursive: true });
    mkdirSync(join(tempLibRoot, "skills/demo"), { recursive: true });

    const dupParagraph =
      "This is a duplicated paragraph used during phase 3 hub verification to confirm that the zero-token rule audit detects repeated blocks of at least two hundred characters across multiple knowledge files accurately.";

    writeFileSync(
      join(tempLibRoot, "plugins/local/lyvan-global/.cursor-plugin/plugin.json"),
      '{\n  "name": "lyvan-global",\n  "version": "1.2.3"\n}\n',
      "utf8"
    );
    writeFileSync(
      join(tempLibRoot, "plugins/local/lyvan-global/rules/core.mdc"),
      `---\nalwaysApply: true\n---\n# Core Rule\n\n${dupParagraph}\n`,
      "utf8"
    );
    writeFileSync(
      join(tempLibRoot, "skills/demo/SKILL.md"),
      `# Demo Skill\n\n${dupParagraph}\n`,
      "utf8"
    );
    writeFileSync(join(tempLibRoot, "feedback-log.md"), "# Feedback Log\n", "utf8");
    // Hard-denied files that MUST NOT appear in tree or be readable/writable
    writeFileSync(join(tempLibRoot, "mcp.json"), '{"token":"deny"}', "utf8");
    writeFileSync(join(tempLibRoot, ".env"), "SECRET_KEY=deny\n", "utf8");
    writeFileSync(
      join(tempLibRoot, "plugins/local/lyvan-global/rules/secret-key.md"),
      "must not appear\n",
      "utf8"
    );
    writeFileSync(tempOutsideFile, "outside-root-content", "utf8");
    symlinkSync(tempOutsideFile, join(tempLibRoot, "skills/demo/escape-link.md"));

    const testLib = new KnowledgeLibrary({ root: tempLibRoot, writable: true });
    const tree = testLib.listTree();
    const paths = new Set(tree.entries.map((e) => e.path));
    libTreeOk =
      paths.has("plugins/local/lyvan-global/rules/core.mdc") &&
      paths.has("skills/demo/SKILL.md") &&
      paths.has("feedback-log.md") &&
      !paths.has("mcp.json") &&
      !paths.has(".env") &&
      !paths.has("plugins/local/lyvan-global/rules/secret-key.md") &&
      !paths.has("skills/demo/escape-link.md");

    // Write check: backup, version bump, feedback line, 409 on stale mtime
    const beforeFile = testLib.readFile("plugins/local/lyvan-global/rules/core.mdc");
    let conflictCaught = false;
    try {
      testLib.writeFile({
        path: "plugins/local/lyvan-global/rules/core.mdc",
        content: beforeFile.content,
        note: "stale mtime test",
        expectedMtime: "1999-01-01T00:00:00.000Z",
      });
    } catch (err) {
      conflictCaught = err instanceof LibraryError && err.status === 409;
    }

    const writeRes = testLib.writeFile({
      path: "plugins/local/lyvan-global/rules/core.mdc",
      content: `${beforeFile.content}\n- Updated line\n`,
      note: "verify phase3 write",
      expectedMtime: beforeFile.mtime,
    });
    const pluginRaw = readFileSync(
      join(tempLibRoot, "plugins/local/lyvan-global/.cursor-plugin/plugin.json"),
      "utf8"
    );
    const feedbackRaw = readFileSync(join(tempLibRoot, "feedback-log.md"), "utf8");
    libWriteOk =
      conflictCaught &&
      writeRes.ok &&
      Boolean(writeRes.backupPath) &&
      existsSync(writeRes.backupPath) &&
      writeRes.pluginVersion === "1.2.4" &&
      pluginRaw.includes('"version": "1.2.4"') &&
      feedbackRaw.includes("[agent-office] edited plugins/local/lyvan-global/rules/core.mdc: verify phase3 write");

    // Path escape & hard-deny rejection check
    const mustReject = (fn: () => unknown) => {
      try {
        fn();
        return false;
      } catch (err) {
        return err instanceof LibraryError && err.status === 403;
      }
    };
    libEscapeRejectedOk =
      mustReject(() => testLib.readFile("../outside.txt")) &&
      mustReject(() => testLib.readFile("skills/demo/escape-link.md")) &&
      mustReject(() => testLib.readFile("mcp.json")) &&
      mustReject(() => testLib.readFile(".env")) &&
      mustReject(() =>
        testLib.writeFile({
          path: "skills/demo/escape-link.md",
          content: "bad",
          note: "escape write test",
        })
      );

    // Sync on non-~/.cursor root must skip without running script
    const syncRes = await testLib.sync({ dryRun: true });
    libSyncSkippedOk = syncRes.ok && syncRes.skipped === "KNOWLEDGE_ROOT is not ~/.cursor";

    // Rule audit run
    const testAudit = new AuditService(testLib);
    const auditReport = testAudit.runRuleAudit();
    auditRuleOk =
      auditReport.kind === "rule" &&
      auditReport.totals.files >= 4 &&
      auditReport.totals.alwaysLoadedTokens > 0 &&
      auditReport.findings.some((f) => f.code === "DUPLICATE_BLOCK");
  } finally {
    try {
      rmSync(tempLibRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      unlinkSync(tempOutsideFile);
    } catch {
      // ignore
    }
  }

  // 6. Verify Accounts Hub (slots, quota parse, model PATCH validation, rotation + cooldown, usage)
  let accSlotCreateCheckOk = false;
  let accQuotaParseOk = false;
  let accModelPatchOk = false;
  let accRotationCooldownOk = false;
  let accUsageCountedOk = false;
  const tempAccDbPath = join(tempAccRoot, "accounts-verify.sqlite");
  try {
    const accDb = new OfficeDatabase(tempAccDbPath);
    const accOrch = new HubOrchestrator(accDb);
    const accSvc = new AccountsService({
      db: accDb,
      orchestrator: accOrch,
      agyBin: stubAgyBin,
      profilesRoot: tempProfilesRoot,
      quotaRefreshMin: 0,
      repoRoot: process.cwd(),
    });

    const initialState = accSvc.getAccounts();
    const hasDefault = initialState.slots.some((s) => s.id === "default" && s.isDefault);
    const hasProviders =
      initialState.providers.length === 10 &&
      initialState.providers.every((p) => p.source === "none" && p.usedPct === null);

    const alpha = accSvc.createSlot({ name: "Slot Alpha" });
    const beta = accSvc.createSlot({ name: "Slot Beta" });

    // Before sign-in -> signed_out
    const alphaSignedOut = await accSvc.checkSlot(alpha.id);

    // Mark both slots signed in + write email in cli.log
    writeFileSync(join(alpha.homeDir, ".stub_signed_in"), "1", "utf8");
    writeFileSync(join(beta.homeDir, ".stub_signed_in"), "1", "utf8");
    mkdirSync(join(alpha.homeDir, ".gemini", "antigravity-cli"), { recursive: true });
    mkdirSync(join(beta.homeDir, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(alpha.homeDir, ".gemini", "antigravity-cli", "cli.log"),
      "info email=old@example.com\ninfo email=alpha@example.com\n",
      "utf8"
    );
    writeFileSync(
      join(beta.homeDir, ".gemini", "antigravity-cli", "cli.log"),
      "info email=beta@example.com\n",
      "utf8"
    );

    const alphaChecked = await accSvc.checkSlot(alpha.id);
    const betaChecked = await accSvc.checkSlot(beta.id);

    accSlotCreateCheckOk =
      hasDefault &&
      hasProviders &&
      alpha.status === "unknown" &&
      alphaSignedOut.status === "signed_out" &&
      alphaChecked.status === "ready" &&
      alphaChecked.email === "alpha@example.com" &&
      betaChecked.status === "ready" &&
      betaChecked.email === "beta@example.com";

    accQuotaParseOk =
      alphaChecked.models.length === 2 &&
      alphaChecked.quota.length === 2 &&
      alphaChecked.quota[0]?.group === "Gemini Models" &&
      alphaChecked.quota[0]?.remainingPct === 97 &&
      alphaChecked.quota[0]?.resetAt === "2026-12-01T08:57:55Z" &&
      alphaChecked.credits === 1250;

    // Model PATCH validation
    let invalidModelRejected = false;
    try {
      accSvc.patchSlot(alpha.id, { model: "non-existent-model" });
    } catch (err) {
      invalidModelRejected = err instanceof AccountsError && err.status === 400;
    }
    const patchedAlpha = accSvc.patchSlot(alpha.id, {
      model: "gemini-2.5-pro",
      effort: "high",
    });
    accModelPatchOk =
      invalidModelRejected &&
      patchedAlpha.model === "gemini-2.5-pro" &&
      patchedAlpha.effort === "high";

    // Rotation test: mark alpha exhausted, run job starting on alpha -> rotates to beta
    writeFileSync(join(alpha.homeDir, ".stub_exhausted"), "1", "utf8");
    const createdJob = accSvc.createJob({
      prompt: "verify rotation test",
      cwd: process.cwd(),
      slotId: alpha.id,
    });
    const finishedJob = await accSvc.waitForJob(createdJob.jobId);
    const alphaAfter = accSvc.getSlot(alpha.id);
    const betaAfter = accSvc.getSlot(beta.id);

    accRotationCooldownOk =
      finishedJob?.status === "done" &&
      finishedJob.slotId === beta.id &&
      finishedJob.attempts.length === 2 &&
      finishedJob.attempts[0]?.slotId === alpha.id &&
      finishedJob.attempts[0]?.outcome === "quota_exhausted" &&
      finishedJob.attempts[1]?.slotId === beta.id &&
      finishedJob.attempts[1]?.outcome === "done" &&
      alphaAfter?.status === "cooldown" &&
      alphaAfter.cooldownUntil === "2099-12-31T23:59:59Z" &&
      Boolean(alphaAfter.lastQuotaError);

    accUsageCountedOk =
      betaAfter?.measured.requests === 1 &&
      betaAfter.measured.totalTokens === 215 &&
      Boolean(betaAfter.measured.lastJobAt);

    accDb.close();
  } finally {
    try {
      rmSync(tempAccRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

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
      recentCount >= 1 &&
      libTreeOk &&
      libWriteOk &&
      libEscapeRejectedOk &&
      libSyncSkippedOk &&
      auditRuleOk &&
      accSlotCreateCheckOk &&
      accQuotaParseOk &&
      accModelPatchOk &&
      accRotationCooldownOk &&
      accUsageCountedOk,
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
    phase3LibraryAndAudit: {
      libTreeOk,
      libWriteOk,
      libEscapeRejectedOk,
      libSyncSkippedOk,
      auditRuleOk,
    },
    accountsHub: {
      accSlotCreateCheckOk,
      accQuotaParseOk,
      accModelPatchOk,
      accRotationCooldownOk,
      accUsageCountedOk,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

const db = new OfficeDatabase();
const orchestrator = new HubOrchestrator(db);
const vault = new SecretsVault();
const library = new KnowledgeLibrary();
const PORT = Number(process.env.AGENT_OFFICE_PORT ?? 4789);
const HOST = process.env.AGENT_OFFICE_HOST ?? "127.0.0.1";
const HUB_DEV = process.env.HUB_DEV === "1";

const wsClients = new Set<{ send(data: string): void }>();
function broadcastWs(message: unknown) {
  const payload = JSON.stringify(message);
  for (const ws of wsClients) {
    ws.send(payload);
  }
}

orchestrator.subscribe((event: AgentEvent) => {
  broadcastWs({ type: "agent_event", event });
});

const auditService = new AuditService(library, db, (report) => {
  broadcastWs({ type: "audit_report", report });
});
auditService.startScheduler();

const accountsService = new AccountsService({
  db,
  orchestrator,
  onAccountsChanged: () => {
    broadcastWs({ type: "accounts_changed" });
  },
  onJobUpdate: (job) => {
    broadcastWs({ type: "agy_job", job });
  },
});
accountsService.startScheduler();

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    // Local-only guard: browsers send Origin; only the local UI (localhost/127.0.0.1) may call the Hub.
    const origin = req.headers.get("origin");
    const originOk = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
    const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
    const hostOk = host === "127.0.0.1" || host === "localhost";
    if (!originOk || !hostOk) {
      return new Response(JSON.stringify({ error: "Origin not allowed" }), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    const headers = {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin ?? "http://127.0.0.1:5173",
      vary: "Origin",
    };

    const jsonError = (status: number, error: string) =>
      new Response(JSON.stringify({ error }), { status, headers });

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
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

    if (url.pathname === "/api/library/tree" && req.method === "GET") {
      try {
        return new Response(JSON.stringify(library.listTree(), null, 2), { headers });
      } catch (err) {
        if (err instanceof LibraryError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (url.pathname === "/api/library/file" && req.method === "GET") {
      const relPath = url.searchParams.get("path") ?? "";
      try {
        return new Response(JSON.stringify(library.readFile(relPath), null, 2), { headers });
      } catch (err) {
        if (err instanceof LibraryError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (url.pathname === "/api/library/file" && req.method === "PUT") {
      const body = (await req.json().catch(() => null)) as {
        path?: string;
        content?: string;
        note?: string;
        expectedMtime?: string;
      } | null;
      if (!body || typeof body !== "object") {
        return jsonError(400, "Invalid JSON body");
      }
      try {
        const result = library.writeFile({
          path: body.path ?? "",
          content: body.content as string,
          note: body.note as string,
          expectedMtime: body.expectedMtime,
        });
        broadcastWs({ type: "library_changed", path: body.path });
        return new Response(JSON.stringify(result, null, 2), { headers });
      } catch (err) {
        if (err instanceof LibraryError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (url.pathname === "/api/library/sync" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
      try {
        const result = await library.sync({ dryRun: body.dryRun });
        broadcastWs({ type: "sync_result", result });
        return new Response(JSON.stringify(result, null, 2), { headers });
      } catch (err) {
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (url.pathname === "/api/audit/latest" && req.method === "GET") {
      const latest = auditService.getLatest();
      return new Response(JSON.stringify(latest ?? { report: null }, null, 2), { headers });
    }

    if (url.pathname === "/api/audit/run" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { ai?: boolean };
      try {
        const report = body.ai ? await auditService.runAiAudit() : auditService.runRuleAudit();
        return new Response(JSON.stringify(report, null, 2), { headers });
      } catch (err) {
        if (err instanceof AuditRateLimitError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (url.pathname === "/api/dev/test-approval" && req.method === "POST") {
      if (!HUB_DEV) {
        return jsonError(404, "Not found");
      }
      const body = (await req.json().catch(() => ({}))) as { action?: string };
      const action =
        typeof body.action === "string" && body.action.trim().length > 0
          ? body.action.trim()
          : "TEST: rm -rf ./tmp-demo (dev test approval)";
      const { approval, decision } = orchestrator.requestApproval({
        taskId: "dev-test",
        agentId: "antigravity",
        provider: "antigravity",
        action,
        detail: "Dev test approval created via POST /api/dev/test-approval",
      });
      decision.then((approved) => {
        console.log(
          `[dev/test-approval] ${approval.id} resolved: ${approved ? "approved" : "denied"}`
        );
      });
      return new Response(JSON.stringify({ approval }, null, 2), { headers });
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

    if (url.pathname === "/api/accounts" && req.method === "GET") {
      return new Response(JSON.stringify(accountsService.getAccounts(), null, 2), { headers });
    }

    if (url.pathname === "/api/accounts/slots" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { name?: string } | null;
      if (!body || typeof body !== "object") {
        return jsonError(400, "Invalid JSON body");
      }
      try {
        const slot = accountsService.createSlot({ name: body.name ?? "" });
        return new Response(JSON.stringify(slot, null, 2), { headers });
      } catch (err) {
        if (err instanceof AccountsError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const slotCheckMatch = url.pathname.match(/^\/api\/accounts\/slots\/([^/]+)\/check$/);
    if (slotCheckMatch && req.method === "POST") {
      try {
        const slot = await accountsService.checkSlot(decodeURIComponent(slotCheckMatch[1]));
        return new Response(JSON.stringify(slot, null, 2), { headers });
      } catch (err) {
        if (err instanceof AccountsError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const slotSignInMatch = url.pathname.match(/^\/api\/accounts\/slots\/([^/]+)\/signin$/);
    if (slotSignInMatch && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { openTerminal?: boolean };
      try {
        const result = accountsService.signInSlot(
          decodeURIComponent(slotSignInMatch[1]),
          Boolean(body?.openTerminal)
        );
        return new Response(JSON.stringify(result, null, 2), { headers });
      } catch (err) {
        if (err instanceof AccountsError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const slotIdMatch = url.pathname.match(/^\/api\/accounts\/slots\/([^/]+)$/);
    if (slotIdMatch && req.method === "PATCH") {
      const body = (await req.json().catch(() => null)) as {
        name?: string;
        model?: string | null;
        effort?: SlotEffort;
        enabled?: boolean;
        manual?: { limitNote?: string; resetRule?: string };
      } | null;
      if (!body || typeof body !== "object") {
        return jsonError(400, "Invalid JSON body");
      }
      try {
        const slot = accountsService.patchSlot(decodeURIComponent(slotIdMatch[1]), body);
        return new Response(JSON.stringify(slot, null, 2), { headers });
      } catch (err) {
        if (err instanceof AccountsError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (slotIdMatch && req.method === "DELETE") {
      const purge = url.searchParams.get("purge") === "1";
      try {
        const result = accountsService.deleteSlot(decodeURIComponent(slotIdMatch[1]), purge);
        return new Response(JSON.stringify(result, null, 2), { headers });
      } catch (err) {
        if (err instanceof AccountsError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const providerIdMatch = url.pathname.match(/^\/api\/accounts\/providers\/([^/]+)$/);
    if (providerIdMatch && req.method === "PATCH") {
      const body = (await req.json().catch(() => null)) as {
        usedPct?: number | null;
        sharePct?: number | null;
        resetAt?: string | null;
        resetRule?: string | null;
        limitNote?: string | null;
        note?: string | null;
        source?: "manual" | "provider_snapshot";
      } | null;
      if (!body || typeof body !== "object") {
        return jsonError(400, "Invalid JSON body");
      }
      try {
        const row = accountsService.patchProvider(decodeURIComponent(providerIdMatch[1]), body);
        return new Response(JSON.stringify(row, null, 2), { headers });
      } catch (err) {
        if (err instanceof AccountsError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (url.pathname === "/api/agy/jobs" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        prompt?: string;
        cwd?: string;
        slotId?: string;
        model?: string;
        effort?: SlotEffort;
        autoEdit?: boolean;
      } | null;
      if (!body || typeof body !== "object") {
        return jsonError(400, "Invalid JSON body");
      }
      try {
        const result = accountsService.createJob({
          prompt: body.prompt ?? "",
          cwd: body.cwd ?? "",
          slotId: body.slotId,
          model: body.model,
          effort: body.effort,
          autoEdit: body.autoEdit,
        });
        return new Response(JSON.stringify(result, null, 2), { headers });
      } catch (err) {
        if (err instanceof AccountsError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const agyJobMatch = url.pathname.match(/^\/api\/agy\/jobs\/([^/]+)$/);
    if (agyJobMatch && req.method === "GET") {
      const job = accountsService.getJob(decodeURIComponent(agyJobMatch[1]));
      if (!job) return jsonError(404, "Job not found");
      return new Response(JSON.stringify(job, null, 2), { headers });
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

    const endpoints = [
      "/health",
      "/api/discovery",
      "/api/knowledge/status",
      "/api/knowledge/lint",
      "/api/library/tree",
      "/api/library/file",
      "/api/library/sync",
      "/api/audit/latest",
      "/api/audit/run",
      "/api/policy",
      "/api/events",
      "/api/approvals",
      "/api/stop-all",
      "/api/accounts",
      "/api/accounts/slots",
      "/api/accounts/slots/:id",
      "/api/accounts/slots/:id/check",
      "/api/accounts/slots/:id/signin",
      "/api/accounts/providers/:id",
      "/api/agy/jobs",
      "/api/agy/jobs/:id",
      "/api/vault/status",
      "/ws",
    ];
    if (HUB_DEV) endpoints.push("/api/dev/test-approval");

    return new Response(
      JSON.stringify({
        service: "agent-office-hub",
        endpoints,
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
