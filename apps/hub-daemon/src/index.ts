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
import type {
  AgentBridge,
  AgentKind,
  AgentOrgProvider,
  BusMessageKind,
  OrgAgentStatus,
  OrgEffort,
} from "../../../packages/protocol/src/org.ts";
import {
  AccountsError,
  AccountsService,
  type SlotEffort,
} from "./accounts.ts";
import { AuditRateLimitError, AuditService } from "./audit.ts";
import { BusError, BusService } from "./bus.ts";
import { OfficeDatabase } from "./db.ts";
import { runDiscovery, scanKnowledgeHub } from "./discovery.ts";
import { KnowledgeLibrary, LibraryError } from "./library.ts";
import { HubOrchestrator } from "./orchestrator.ts";
import { OrgError, OrgService, resolveActorId } from "./org.ts";
import { lintKnowledgeBudget, loadPolicies, TaskGuard } from "./policy.ts";
import { redactSensitiveText, SignInManager, type SignInSession } from "./signin.ts";
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
if [ $# -eq 0 ]; then
  printf "Welcome to the Antigravity CLI. You are currently not signed in.\\n"
  printf "Select login method:\\n> 1. Google OAuth\\n  2. Use a Google Cloud project\\n"
  IFS= read -r _choice
  open "https://accounts.google.com/o/oauth2/auth?client_id=x&state=SECRET&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback"
  printf "If you aren't automatically redirected, paste the authorization code below:\\n"
  IFS= read -r code
  code=$(printf '%s' "$code" | tr -d '\\r\\n')
  case "$code" in
    GOODCODE*)
      touch "$HOME/.stub_signed_in"
      mkdir -p "$HOME/.gemini/antigravity-cli"
      printf "info email=signin-verify@example.com\\n" > "$HOME/.gemini/antigravity-cli/cli.log"
      printf "Signed in successfully.\\n"
      exit 0
      ;;
    *)
      printf "Invalid code\\n"
      exit 1
      ;;
  esac
fi
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
        CNT_FILE="${tempAccRoot}/.stub_turn_count"
        CNT=1
        if [ -f "$CNT_FILE" ]; then
          CNT=$(($(cat "$CNT_FILE") + 1))
        fi
        echo "$CNT" > "$CNT_FILE"
        printf '{"type":"result","result":{"text":"Stub summary turn #%s.\\\\nChi tiet phan hoi stub agy luot #%s.","usage":{"input_tokens":120,"output_tokens":80,"thinking_tokens":10,"cache_read_tokens":5,"total_tokens":215}}}\\n' "$CNT" "$CNT"
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
  } catch (err) {
    console.error("Accounts verify error:", err);
  }

  // 7. Verify Org, Message Bus, Meeting Room, Guardrails, Handoff & Run (temp DB + stub agy)
  let orgSeedOk = false;
  let orgSameDeptDirectOk = false;
  let orgCrossDeptRejectedOk = false;
  let orgCrossDeptMeetingOk = false;
  let orgNonParticipantRejectedOk = false;
  let orgHandoffOk = false;
  let orgHeadAssignOk = false;
  let orgNonAdminStopAllOk = false;
  let orgTurnCapOk = false;
  let orgLoopGuardOk = false;
  let orgMeetingRunOk = false;
  const tempOrgDbPath = join(tempAccRoot, "org-verify.sqlite");
  try {
    const orgDb = new OfficeDatabase(tempOrgDbPath);
    const orgOrch = new HubOrchestrator(orgDb);
    const orgAcc = new AccountsService({
      db: orgDb,
      orchestrator: orgOrch,
      agyBin: stubAgyBin,
      profilesRoot: tempProfilesRoot,
      quotaRefreshMin: 0,
      repoRoot: process.cwd(),
    });
    const guardrailEvents: Array<{ conversationId: string; reason: string }> = [];
    const orgSvc = new OrgService({ db: orgDb });
    const busSvc = new BusService({
      db: orgDb,
      org: orgSvc,
      accounts: orgAcc,
      orchestrator: orgOrch,
      repoRoot: process.cwd(),
      onGuardrail: (conversationId, reason) => {
        guardrailEvents.push({ conversationId, reason });
      },
    });

    // 7.1 Seed present
    const snapshot = orgSvc.getOrg();
    const baAgent = orgSvc.getAgent("ba-agy-1");
    const beAgent = orgSvc.getAgent("be-agy-1");
    const lyVan = orgSvc.getAgent("ly-van");
    const baHead = orgSvc.getAgent("chuyen-gia-ba");
    orgSeedOk =
      snapshot.departments.length === 11 &&
      snapshot.roles.length === 11 &&
      snapshot.agents.length === 10 &&
      Boolean(lyVan?.isAdmin && lyVan.isHead && lyVan.kind === "human") &&
      Boolean(baHead?.isHead && !baHead.isAdmin) &&
      Boolean(baAgent?.bridge === "hub" && baAgent.departmentId === "ba") &&
      Boolean(beAgent?.bridge === "hub" && beAgent.departmentId === "backend");

    // 7.2 Same-dept direct OK
    const sameDeptMsg = busSvc.postMessage({
      fromAgentId: "ba-agy-1",
      toAgentId: "chuyen-gia-ba",
      kind: "request",
      summary: "Xin xac nhan pham vi nghiep vu",
      body: "Can chot danh sach API truoc khi chuyen Backend.",
    });
    orgSameDeptDirectOk =
      sameDeptMsg.status === "delivered" &&
      Boolean(sameDeptMsg.conversationId) &&
      sameDeptMsg.tokenEstimate > 0;

    // 7.3 Cross-dept direct rejected + logged
    let crossRejectedStatus = 0;
    let crossRejectedReason = "";
    try {
      busSvc.postMessage({
        fromAgentId: "ba-agy-1",
        toAgentId: "be-agy-1",
        kind: "request",
        summary: "Nhan truc tiep xuyen phong ban",
      });
    } catch (err) {
      if (err instanceof BusError) {
        crossRejectedStatus = err.status;
        crossRejectedReason = err.reason ?? "";
      }
    }
    const loggedMessages = busSvc.listMessages({ includeRejected: true, limit: 50 });
    orgCrossDeptRejectedOk =
      crossRejectedStatus === 403 &&
      crossRejectedReason === "cross_department_direct_not_allowed" &&
      loggedMessages.some(
        (m) =>
          m.status === "rejected" &&
          m.fromAgentId === "ba-agy-1" &&
          m.toAgentId === "be-agy-1" &&
          m.rejectReason === "cross_department_direct_not_allowed"
      );

    // 7.4 Cross-dept via meeting OK
    const meeting = busSvc.createConversation("chuyen-gia-ba", {
      type: "meeting",
      title: "Hop chot contract BA-BE",
      participants: ["ba-agy-1", "be-agy-1"],
      turnCap: 12,
    });
    const m1 = busSvc.postMessage({
      fromAgentId: "ba-agy-1",
      toAgentId: "be-agy-1",
      conversationId: meeting.id,
      kind: "meeting",
      summary: "BA de xuat schema Org va Bus",
    });
    const m2 = busSvc.postMessage({
      fromAgentId: "be-agy-1",
      toAgentId: "ba-agy-1",
      conversationId: meeting.id,
      kind: "meeting",
      summary: "BE dong y va bo sung chi muc sqlite",
    });
    orgCrossDeptMeetingOk = m1.status === "delivered" && m2.status === "delivered";

    // 7.5 Non-participant rejected
    let nonPartStatus = 0;
    try {
      busSvc.postMessage({
        fromAgentId: "hacker-lo",
        conversationId: meeting.id,
        kind: "meeting",
        summary: "Toi khong o trong phong hop nay",
      });
    } catch (err) {
      if (err instanceof BusError) nonPartStatus = err.status;
    }
    orgNonParticipantRejectedOk =
      nonPartStatus === 403 &&
      busSvc
        .listMessages({ conversationId: meeting.id, includeRejected: true })
        .some(
          (m) =>
            m.status === "rejected" &&
            m.fromAgentId === "hacker-lo" &&
            m.rejectReason === "sender_not_participant"
        );

    // 7.6 Handoff creates conversation + task with summary only
    const handoffRes = busSvc.handoffTask("ba-agy-1", {
      title: "Ban giao spec ORG-HUB",
      toDepartmentId: "backend",
      summary: "Da chot contract phong ban va bus",
      decisions: ["Dung sqlite", "Khong them dependency moi"],
    });
    orgHandoffOk =
      handoffRes.kind === "handoff" &&
      handoffRes.status === "handed_off" &&
      handoffRes.conversationId === handoffRes.conversation.id &&
      handoffRes.conversation.type === "handoff" &&
      handoffRes.message.kind === "handoff" &&
      handoffRes.message.status === "delivered" &&
      (handoffRes.message.body?.length ?? 0) <= 1500 &&
      handoffRes.decisions.length === 2;

    // 7.7 Head assigns in own dept OK, other dept 403
    const ownAssign = busSvc.assignTask("chuyen-gia-ba", {
      title: "Viet tai lieu BA",
      departmentId: "ba",
      toAgentId: "ba-agy-1",
      summary: "Hoan thien tai lieu phan tich",
    });
    let otherDeptAssignStatus = 0;
    try {
      busSvc.assignTask("chuyen-gia-ba", {
        title: "Giao viec sai phong",
        departmentId: "backend",
        toAgentId: "be-agy-1",
        summary: "Khong duoc phep",
      });
    } catch (err) {
      if (err instanceof BusError) otherDeptAssignStatus = err.status;
    }
    orgHeadAssignOk = ownAssign.status === "assigned" && otherDeptAssignStatus === 403;

    // 7.8 Non-admin stop-all 403
    let nonAdminStatus = 0;
    try {
      orgSvc.requireAdmin("ba-agy-1");
    } catch (err) {
      if (err instanceof OrgError) nonAdminStatus = err.status;
    }
    const defaultActorIsAdmin = orgSvc.isAdmin(resolveActorId(null));
    orgNonAdminStopAllOk = nonAdminStatus === 403 && defaultActorIsAdmin;

    // 7.9 Turn cap closes with summary
    const capConv = busSvc.createConversation("ly-van", {
      type: "meeting",
      title: "Hop test turn cap",
      participants: ["ba-agy-1", "be-agy-1"],
      turnCap: 3,
    });
    busSvc.postMessage({
      fromAgentId: "ba-agy-1",
      conversationId: capConv.id,
      kind: "meeting",
      summary: "Luot mot tu BA",
    });
    busSvc.postMessage({
      fromAgentId: "be-agy-1",
      conversationId: capConv.id,
      kind: "meeting",
      summary: "Luot hai tu BE",
    });
    busSvc.postMessage({
      fromAgentId: "ba-agy-1",
      conversationId: capConv.id,
      kind: "meeting",
      summary: "Luot ba chot van de",
    });
    const capAfter = busSvc.getConversationWithMessages(capConv.id);
    orgTurnCapOk =
      capAfter?.status === "closed" &&
      Boolean(capAfter.summary && capAfter.summary.includes("Luot mot tu BA")) &&
      Boolean(capAfter.closedAt) &&
      guardrailEvents.some(
        (g) => g.conversationId === capConv.id && g.reason === "turn_cap_reached"
      );

    // 7.10 Loop guard pauses
    const loopConv = busSvc.createConversation("ly-van", {
      type: "meeting",
      title: "Hop test loop guard",
      participants: ["ba-agy-1", "be-agy-1"],
      turnCap: 10,
    });
    for (let i = 0; i < 3; i++) {
      busSvc.postMessage({
        fromAgentId: i % 2 === 0 ? "ba-agy-1" : "be-agy-1",
        conversationId: loopConv.id,
        kind: "meeting",
        summary: "Noi dung lap y het nhau",
      });
    }
    const loopAfter = busSvc.getConversationWithMessages(loopConv.id);
    orgLoopGuardOk =
      loopAfter?.status === "paused" &&
      Boolean(loopAfter.pauseReason && loopAfter.pauseReason.includes("loop_guard")) &&
      guardrailEvents.some(
        (g) => g.conversationId === loopConv.id && g.reason.includes("loop_guard")
      );

    // 7.11 run() with 2 hub agents (ba-agy-1, be-agy-1) produces meeting messages from stub
    const runConv = busSvc.createConversation("ly-van", {
      type: "meeting",
      title: "Hop tu dong 2 agent hub",
      participants: ["ba-agy-1", "be-agy-1", "chuyen-gia-ba"],
      turnCap: 12,
    });
    const runStarted = busSvc.startMeetingRun(runConv.id, {
      rounds: 1,
      prompt: "Chot ke hoach trien khai ORG-HUB",
    });
    const runFinished = await busSvc.waitForRun(runStarted.runId);
    const runConvAfter = busSvc.getConversationWithMessages(runConv.id);
    const defaultSlotAfter = orgAcc.getSlot("default");
    const runDelivered = (runConvAfter?.messages ?? []).filter((m) => m.status === "delivered");
    orgMeetingRunOk =
      runStarted.ok &&
      runFinished?.status === "done" &&
      runDelivered.length === 2 &&
      runDelivered[0]?.fromAgentId === "ba-agy-1" &&
      runDelivered[1]?.fromAgentId === "be-agy-1" &&
      (runFinished.skippedParticipants.some((s) => s.agentId === "chuyen-gia-ba") ?? false) &&
      (defaultSlotAfter?.measured.requests ?? 0) >= 2 &&
      (defaultSlotAfter?.measured.totalTokens ?? 0) >= 430;

    orgDb.close();
  } finally {
    // keep tempAccRoot until web sign-in verification completes below
  }

  // 8. Verify Web Sign-In (pty-bridge + SignInManager + stub agy)
  let signInDefaultRefusedOk = false;
  let signInStartCaptureOk = false;
  let signInSubmitCompleteOk = false;
  let signInCancelOk = false;
  let signInTimeoutOk = false;
  let signInLogsCleanOk = false;
  const tempSignInDbPath = join(tempAccRoot, "signin-verify.sqlite");
  const capturedSignInLogs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const prevTimeoutEnv = process.env.SIGNIN_TIMEOUT_MS;

  const waitForSignInState = async (
    mgr: SignInManager,
    slotId: string,
    targetStates: Set<string>,
    maxMs = 6000
  ): Promise<SignInSession | null> => {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const s = mgr.getSession(slotId);
      if (s && targetStates.has(s.state)) return s;
      await Bun.sleep(50);
    }
    return mgr.getSession(slotId);
  };

  console.log = (...items: unknown[]) => {
    capturedSignInLogs.push(items.map(String).join(" "));
  };
  console.warn = (...items: unknown[]) => {
    capturedSignInLogs.push(items.map(String).join(" "));
  };
  console.error = (...items: unknown[]) => {
    capturedSignInLogs.push(items.map(String).join(" "));
  };

  try {
    const signInDb = new OfficeDatabase(tempSignInDbPath);
    const signInOrch = new HubOrchestrator(signInDb);
    const signInAcc = new AccountsService({
      db: signInDb,
      orchestrator: signInOrch,
      agyBin: stubAgyBin,
      profilesRoot: tempProfilesRoot,
      quotaRefreshMin: 0,
      repoRoot: process.cwd(),
    });
    const signInMgr = new SignInManager({
      accounts: signInAcc,
      agyBin: stubAgyBin,
    });

    try {
      // 8.1 Default slot refused unless force
      try {
        signInMgr.start("default");
      } catch (err) {
        signInDefaultRefusedOk = err instanceof AccountsError && err.status === 400;
      }

      // 8.2 Happy path: start -> awaiting_user (URL captured) -> submitCode -> completed + slot ready
      const happySlot = signInAcc.createSlot({ name: "SignIn Happy" });
      signInMgr.start(happySlot.id);
      const awaiting = await waitForSignInState(signInMgr, happySlot.id, new Set(["awaiting_user"]));
      signInStartCaptureOk =
        awaiting?.state === "awaiting_user" &&
        awaiting.authUrl ===
          "https://accounts.google.com/o/oauth2/auth?client_id=x&state=SECRET&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback";

      // Validation check: short / whitespace code rejected
      let invalidCodeRejected = false;
      try {
        signInMgr.submitCode(happySlot.id, "short");
      } catch (err) {
        invalidCodeRejected = err instanceof AccountsError && err.status === 400;
      }

      signInMgr.submitCode(happySlot.id, "GOODCODE1234");
      const completed = await waitForSignInState(
        signInMgr,
        happySlot.id,
        new Set(["completed", "failed", "timeout"])
      );
      const happySlotAfter = signInAcc.getSlot(happySlot.id);
      signInSubmitCompleteOk =
        invalidCodeRejected &&
        completed?.state === "completed" &&
        happySlotAfter?.status === "ready" &&
        happySlotAfter.email === "signin-verify@example.com";

      // 8.3 Cancel path
      const cancelSlot = signInAcc.createSlot({ name: "SignIn Cancel" });
      signInMgr.start(cancelSlot.id);
      const cancelAwaiting = await waitForSignInState(
        signInMgr,
        cancelSlot.id,
        new Set(["awaiting_user"])
      );
      const cancelled = signInMgr.cancel(cancelSlot.id);
      signInCancelOk = cancelAwaiting?.state === "awaiting_user" && cancelled.state === "cancelled";

      // 8.4 Timeout path (short override via SIGNIN_TIMEOUT_MS)
      process.env.SIGNIN_TIMEOUT_MS = "1200";
      const timeoutSlot = signInAcc.createSlot({ name: "SignIn Timeout" });
      signInMgr.start(timeoutSlot.id);
      const timedOut = await waitForSignInState(signInMgr, timeoutSlot.id, new Set(["timeout"]), 5000);
      signInTimeoutOk = timedOut?.state === "timeout";

      // 8.5 Redaction check + no SECRET or GOODCODE in hub log output
      const redactedSample = redactSensitiveText(
        "https://accounts.google.com/o/oauth2/auth?state=SECRET&code=GOODCODE1234&nonce=N1"
      );
      const allLogs = capturedSignInLogs.join("\n");
      signInLogsCleanOk =
        !allLogs.includes("SECRET") &&
        !allLogs.includes("GOODCODE") &&
        !redactedSample.includes("SECRET") &&
        !redactedSample.includes("GOODCODE") &&
        redactedSample.includes("state=<redacted>") &&
        redactedSample.includes("code=<redacted>");
    } finally {
      signInMgr.disposeAll();
      signInDb.close();
    }
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    if (prevTimeoutEnv === undefined) {
      delete process.env.SIGNIN_TIMEOUT_MS;
    } else {
      process.env.SIGNIN_TIMEOUT_MS = prevTimeoutEnv;
    }
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
      accUsageCountedOk &&
      orgSeedOk &&
      orgSameDeptDirectOk &&
      orgCrossDeptRejectedOk &&
      orgCrossDeptMeetingOk &&
      orgNonParticipantRejectedOk &&
      orgHandoffOk &&
      orgHeadAssignOk &&
      orgNonAdminStopAllOk &&
      orgTurnCapOk &&
      orgLoopGuardOk &&
      orgMeetingRunOk &&
      signInDefaultRefusedOk &&
      signInStartCaptureOk &&
      signInSubmitCompleteOk &&
      signInCancelOk &&
      signInTimeoutOk &&
      signInLogsCleanOk,
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
    orgHub: {
      orgSeedOk,
      orgSameDeptDirectOk,
      orgCrossDeptRejectedOk,
      orgCrossDeptMeetingOk,
      orgNonParticipantRejectedOk,
      orgHandoffOk,
      orgHeadAssignOk,
      orgNonAdminStopAllOk,
      orgTurnCapOk,
      orgLoopGuardOk,
      orgMeetingRunOk,
    },
    webSignIn: {
      signInDefaultRefusedOk,
      signInStartCaptureOk,
      signInSubmitCompleteOk,
      signInCancelOk,
      signInTimeoutOk,
      signInLogsCleanOk,
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

const signInManager = new SignInManager({
  accounts: accountsService,
  onSessionUpdate: (session) => {
    broadcastWs({ type: "signin", session });
  },
});

const orgService = new OrgService({
  db,
  onOrgChanged: () => {
    broadcastWs({ type: "org_changed" });
  },
});

const busService = new BusService({
  db,
  org: orgService,
  accounts: accountsService,
  orchestrator,
  repoRoot: process.cwd(),
  onBusMessage: (message) => {
    broadcastWs({ type: "bus_message", message });
  },
  onBusRejected: (message) => {
    broadcastWs({ type: "bus_rejected", message });
  },
  onConversationChanged: (conversation) => {
    broadcastWs({ type: "conversation_changed", conversation });
  },
  onGuardrail: (conversationId, reason) => {
    broadcastWs({ type: "guardrail", conversationId, reason });
  },
});

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

    const jsonError = (status: number, error: string, reason?: string) =>
      new Response(JSON.stringify(reason ? { error, reason } : { error }), { status, headers });

    const actorId = resolveActorId(req.headers.get("x-actor-id"));

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type, x-actor-id",
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
      try {
        orgService.requireAdmin(actorId);
      } catch (err) {
        if (err instanceof OrgError) return jsonError(err.status, err.message, err.reason);
        return jsonError(403, "Admin permission required");
      }
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
      try {
        orgService.requireAdmin(actorId);
      } catch (err) {
        if (err instanceof OrgError) return jsonError(err.status, err.message, err.reason);
        return jsonError(403, "Admin permission required");
      }
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

    const slotSignInStartMatch = url.pathname.match(/^\/api\/accounts\/slots\/([^/]+)\/signin\/start$/);
    if (slotSignInStartMatch && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { force?: boolean };
      try {
        const session = signInManager.start(decodeURIComponent(slotSignInStartMatch[1]), {
          force: Boolean(body?.force),
        });
        return new Response(JSON.stringify(session, null, 2), { headers });
      } catch (err) {
        if (err instanceof AccountsError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const slotSignInCodeMatch = url.pathname.match(/^\/api\/accounts\/slots\/([^/]+)\/signin\/code$/);
    if (slotSignInCodeMatch && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { code?: string } | null;
      if (!body || typeof body !== "object") {
        return jsonError(400, "Invalid JSON body");
      }
      try {
        const session = signInManager.submitCode(
          decodeURIComponent(slotSignInCodeMatch[1]),
          body.code ?? ""
        );
        return new Response(JSON.stringify(session, null, 2), { headers });
      } catch (err) {
        if (err instanceof AccountsError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const slotSignInCancelMatch = url.pathname.match(/^\/api\/accounts\/slots\/([^/]+)\/signin\/cancel$/);
    if (slotSignInCancelMatch && req.method === "POST") {
      try {
        const session = signInManager.cancel(decodeURIComponent(slotSignInCancelMatch[1]));
        return new Response(JSON.stringify(session, null, 2), { headers });
      } catch (err) {
        if (err instanceof AccountsError) return jsonError(err.status, err.message);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const slotSignInMatch = url.pathname.match(/^\/api\/accounts\/slots\/([^/]+)\/signin$/);
    if (slotSignInMatch && req.method === "GET") {
      const slotId = decodeURIComponent(slotSignInMatch[1]);
      const session = signInManager.getSession(slotId);
      return new Response(JSON.stringify(session ?? { session: null }, null, 2), { headers });
    }

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

    // --- Org Registry ---
    if (url.pathname === "/api/org" && req.method === "GET") {
      return new Response(JSON.stringify(orgService.getOrg(), null, 2), { headers });
    }

    if (url.pathname === "/api/org/agents" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        id?: string;
        name?: string;
        departmentId?: string;
        roleId?: string;
        kind?: AgentKind;
        provider?: AgentOrgProvider;
        slotId?: string | null;
        model?: string | null;
        effort?: OrgEffort;
        isAdmin?: boolean;
        status?: OrgAgentStatus;
        bridge?: AgentBridge;
        note?: string | null;
      } | null;
      if (!body || typeof body !== "object") return jsonError(400, "Invalid JSON body");
      try {
        const agent = orgService.createAgent(actorId, {
          id: body.id,
          name: body.name ?? "",
          departmentId: body.departmentId ?? "",
          roleId: body.roleId ?? "",
          kind: body.kind,
          provider: body.provider,
          slotId: body.slotId,
          model: body.model,
          effort: body.effort,
          isAdmin: body.isAdmin,
          status: body.status,
          bridge: body.bridge,
          note: body.note,
        });
        return new Response(JSON.stringify(agent, null, 2), { headers });
      } catch (err) {
        if (err instanceof OrgError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const orgAgentMatch = url.pathname.match(/^\/api\/org\/agents\/([^/]+)$/);
    if (orgAgentMatch && req.method === "PATCH") {
      const body = (await req.json().catch(() => null)) as {
        name?: string;
        departmentId?: string;
        roleId?: string;
        kind?: AgentKind;
        provider?: AgentOrgProvider;
        slotId?: string | null;
        model?: string | null;
        effort?: OrgEffort;
        isAdmin?: boolean;
        status?: OrgAgentStatus;
        bridge?: AgentBridge;
        note?: string | null;
      } | null;
      if (!body || typeof body !== "object") return jsonError(400, "Invalid JSON body");
      try {
        const agent = orgService.patchAgent(actorId, decodeURIComponent(orgAgentMatch[1]), body);
        return new Response(JSON.stringify(agent, null, 2), { headers });
      } catch (err) {
        if (err instanceof OrgError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (orgAgentMatch && req.method === "DELETE") {
      try {
        const result = orgService.deleteAgent(actorId, decodeURIComponent(orgAgentMatch[1]));
        return new Response(JSON.stringify(result, null, 2), { headers });
      } catch (err) {
        if (err instanceof OrgError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const orgDeptMatch = url.pathname.match(/^\/api\/org\/departments\/([^/]+)$/);
    if (orgDeptMatch && req.method === "PATCH") {
      const body = (await req.json().catch(() => null)) as { headAgentId?: string | null } | null;
      if (!body || typeof body !== "object" || !("headAgentId" in body)) {
        return jsonError(400, "headAgentId is required");
      }
      try {
        const dept = orgService.patchDepartment(actorId, decodeURIComponent(orgDeptMatch[1]), {
          headAgentId: body.headAgentId ?? null,
        });
        return new Response(JSON.stringify(dept, null, 2), { headers });
      } catch (err) {
        if (err instanceof OrgError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    // --- Message Bus ---
    if (url.pathname === "/api/bus/messages" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        fromAgentId?: string;
        toAgentId?: string | null;
        conversationId?: string | null;
        taskId?: string | null;
        kind?: BusMessageKind;
        summary?: string;
        body?: string | null;
      } | null;
      if (!body || typeof body !== "object") return jsonError(400, "Invalid JSON body");
      try {
        const msg = busService.postMessage({
          fromAgentId: body.fromAgentId ?? actorId,
          toAgentId: body.toAgentId,
          conversationId: body.conversationId,
          taskId: body.taskId,
          kind: body.kind as BusMessageKind,
          summary: body.summary ?? "",
          body: body.body,
        });
        return new Response(JSON.stringify(msg, null, 2), { headers });
      } catch (err) {
        if (err instanceof BusError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (url.pathname === "/api/bus/messages" && req.method === "GET") {
      const conversationId = url.searchParams.get("conversationId") || undefined;
      const rawLimit = Number(url.searchParams.get("limit") ?? 100);
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
      const includeRejected = url.searchParams.get("includeRejected") !== "0";
      const msgs = busService.listMessages({ conversationId, limit, includeRejected });
      return new Response(JSON.stringify(msgs, null, 2), { headers });
    }

    // --- Conversations (Meeting Room) ---
    if (url.pathname === "/api/conversations" && req.method === "GET") {
      const status = url.searchParams.get("status") || "all";
      return new Response(JSON.stringify(busService.listConversations(status), null, 2), {
        headers,
      });
    }

    if (url.pathname === "/api/conversations" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        type?: "meeting" | "direct" | "handoff";
        title?: string;
        participants?: string[];
        turnCap?: number;
        taskId?: string | null;
      } | null;
      if (!body || typeof body !== "object") return jsonError(400, "Invalid JSON body");
      try {
        const conv = busService.createConversation(actorId, {
          type: body.type ?? "meeting",
          title: body.title ?? "",
          participants: body.participants ?? [],
          turnCap: body.turnCap,
          taskId: body.taskId,
        });
        return new Response(JSON.stringify(conv, null, 2), { headers });
      } catch (err) {
        if (err instanceof BusError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const convCloseMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/close$/);
    if (convCloseMatch && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { summary?: string };
      try {
        const conv = busService.closeConversation(
          actorId,
          decodeURIComponent(convCloseMatch[1]),
          body?.summary
        );
        return new Response(JSON.stringify(conv, null, 2), { headers });
      } catch (err) {
        if (err instanceof BusError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const convResumeMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/resume$/);
    if (convResumeMatch && req.method === "POST") {
      try {
        const conv = busService.resumeConversation(actorId, decodeURIComponent(convResumeMatch[1]));
        return new Response(JSON.stringify(conv, null, 2), { headers });
      } catch (err) {
        if (err instanceof BusError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const convRunMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/run$/);
    if (convRunMatch && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        rounds?: number;
        prompt?: string;
      } | null;
      if (!body || typeof body !== "object") return jsonError(400, "Invalid JSON body");
      try {
        const res = busService.startMeetingRun(decodeURIComponent(convRunMatch[1]), {
          rounds: body.rounds,
          prompt: body.prompt ?? "",
        });
        return new Response(JSON.stringify(res, null, 2), { headers });
      } catch (err) {
        if (err instanceof BusError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    const convIdMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (convIdMatch && req.method === "GET") {
      const conv = busService.getConversationWithMessages(decodeURIComponent(convIdMatch[1]));
      if (!conv) return jsonError(404, "Conversation not found");
      return new Response(JSON.stringify(conv, null, 2), { headers });
    }

    // --- Tasks (Assign & Handoff) ---
    if (url.pathname === "/api/tasks/assign" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        title?: string;
        departmentId?: string;
        toAgentId?: string | null;
        summary?: string;
        decisions?: string[];
      } | null;
      if (!body || typeof body !== "object") return jsonError(400, "Invalid JSON body");
      try {
        const task = busService.assignTask(actorId, {
          title: body.title ?? "",
          departmentId: body.departmentId ?? "",
          toAgentId: body.toAgentId,
          summary: body.summary ?? "",
          decisions: body.decisions,
        });
        return new Response(JSON.stringify(task, null, 2), { headers });
      } catch (err) {
        if (err instanceof BusError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (url.pathname === "/api/tasks/handoff" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        title?: string;
        fromAgentId?: string;
        departmentId?: string;
        toDepartmentId?: string;
        toAgentId?: string | null;
        summary?: string;
        decisions?: string[];
      } | null;
      if (!body || typeof body !== "object") return jsonError(400, "Invalid JSON body");
      try {
        const result = busService.handoffTask(actorId, {
          title: body.title ?? "",
          fromAgentId: body.fromAgentId,
          departmentId: body.departmentId,
          toDepartmentId: body.toDepartmentId,
          toAgentId: body.toAgentId,
          summary: body.summary ?? "",
          decisions: body.decisions,
        });
        return new Response(JSON.stringify(result, null, 2), { headers });
      } catch (err) {
        if (err instanceof BusError) return jsonError(err.status, err.message, err.reason);
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
    }

    if (url.pathname === "/api/tasks" && req.method === "GET") {
      return new Response(JSON.stringify(busService.listTasks(), null, 2), { headers });
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
      "/api/accounts/slots/:id/signin/start",
      "/api/accounts/slots/:id/signin/code",
      "/api/accounts/slots/:id/signin/cancel",
      "/api/accounts/providers/:id",
      "/api/agy/jobs",
      "/api/agy/jobs/:id",
      "/api/vault/status",
      "/api/org",
      "/api/org/agents",
      "/api/org/agents/:id",
      "/api/org/departments/:id",
      "/api/bus/messages",
      "/api/conversations",
      "/api/conversations/:id",
      "/api/conversations/:id/close",
      "/api/conversations/:id/resume",
      "/api/conversations/:id/run",
      "/api/tasks",
      "/api/tasks/assign",
      "/api/tasks/handoff",
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
