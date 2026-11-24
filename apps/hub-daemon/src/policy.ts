import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface PoliciesConfig {
  schemaVersion: number;
  loopGuard: {
    repeatedFileEditWarn: number;
    repeatedFileEditAbort: number;
    repeatedFileEditWindowMs: number;
    repeatedFailingCmdWarn: number;
    repeatedFailingCmdAbortConsecutive: number;
    repeatedFailingCmdAbortPerTask: number;
    noProgressToolBurstAbort: number;
    maxStepsNormal: number;
    maxStepsLarge: number;
  };
  contextGuard: {
    charsPerTokenEstimate: number;
    maxToolOutputChars: number;
    warnTurns: number;
    warnChars: number;
    abortTurns: number;
    abortChars: number;
    compactBriefMaxChars: number;
  };
  routing: {
    pinAntigravityAccountPerSession: boolean;
    disallowDuplicateParallelTask: boolean;
  };
  knowledgeBudget: {
    bytesPerTokenSafe: number;
    alwaysOnWarnTokens: number;
    alwaysOnBlockTokens: number;
    alwaysOnHardLimitTokens: number;
    antigravityFileWarnBytes: number;
    antigravityFileBlockBytes: number;
    antigravityFileHardLimitBytes: number;
    feedbackLogWarnLines: number;
  };
}

export function getDataDir(): string {
  return process.env.AGENT_OFFICE_DATA_DIR || join(homedir(), "agent-office-data");
}

export function ensureDataDirLayout(): string {
  const base = getDataDir();
  for (const sub of ["config", "db", "vault", "bin", "backups", "worktrees"]) {
    mkdirSync(join(base, sub), { recursive: true });
  }
  return base;
}

export function loadPolicies(): PoliciesConfig {
  const dataDir = ensureDataDirLayout();
  const target = join(dataDir, "config", "policies.json");
  const defaultPath = resolve(dirname(import.meta.dir), "..", "..", "config", "policies.default.json");

  if (!existsSync(target) && existsSync(defaultPath)) {
    copyFileSync(defaultPath, target);
  }
  const source = existsSync(target) ? target : defaultPath;
  return JSON.parse(readFileSync(source, "utf8")) as PoliciesConfig;
}

export interface BudgetFinding {
  severity: "ok" | "warn" | "block";
  code: string;
  message: string;
  path?: string;
  value?: number;
  limit?: number;
}

export interface KnowledgeLintReport {
  checkedAt: string;
  canSync: boolean;
  alwaysOnBytes: number;
  alwaysOnEstimatedTokens: number;
  feedbackLogLines: number;
  findings: BudgetFinding[];
}

function collectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export function lintKnowledgeBudget(policies: PoliciesConfig): KnowledgeLintReport {
  const cursorRoot = join(homedir(), ".cursor");
  const geminiRulesDir = join(homedir(), ".gemini", "config", "rules");
  const findings: BudgetFinding[] = [];
  let alwaysOnBytes = 0;

  const rulesDir = join(cursorRoot, "plugins", "local", "lyvan-global", "rules");
  for (const file of collectFiles(rulesDir)) {
    const content = readFileSync(file, "utf8");
    const size = statSync(file).size;
    if (/alwaysApply:\s*true/i.test(content)) {
      alwaysOnBytes += size;
    }
    if (size >= policies.knowledgeBudget.antigravityFileBlockBytes) {
      findings.push({
        severity: "block",
        code: "rule_file_too_large",
        path: file,
        value: size,
        limit: policies.knowledgeBudget.antigravityFileHardLimitBytes,
        message: `Rule file ${size} bytes reaches block threshold (${policies.knowledgeBudget.antigravityFileBlockBytes})`,
      });
    } else if (size >= policies.knowledgeBudget.antigravityFileWarnBytes) {
      findings.push({
        severity: "warn",
        code: "rule_file_near_limit",
        path: file,
        value: size,
        limit: policies.knowledgeBudget.antigravityFileHardLimitBytes,
        message: `Rule file ${size} bytes is nearing 24 KB limit`,
      });
    }
  }

  for (const file of collectFiles(geminiRulesDir)) {
    const size = statSync(file).size;
    if (size >= policies.knowledgeBudget.antigravityFileBlockBytes) {
      findings.push({
        severity: "block",
        code: "gemini_rule_too_large",
        path: file,
        value: size,
        limit: policies.knowledgeBudget.antigravityFileHardLimitBytes,
        message: `Synced Antigravity rule ${size} bytes reaches block threshold`,
      });
    }
  }

  const alwaysOnEstimatedTokens = Math.ceil(
    alwaysOnBytes / policies.knowledgeBudget.bytesPerTokenSafe
  );
  if (alwaysOnEstimatedTokens >= policies.knowledgeBudget.alwaysOnBlockTokens) {
    findings.push({
      severity: "block",
      code: "always_on_budget_exceeded",
      value: alwaysOnEstimatedTokens,
      limit: policies.knowledgeBudget.alwaysOnHardLimitTokens,
      message: `Always-on rules estimated at ${alwaysOnEstimatedTokens} tokens (>= block ${policies.knowledgeBudget.alwaysOnBlockTokens})`,
    });
  } else if (alwaysOnEstimatedTokens >= policies.knowledgeBudget.alwaysOnWarnTokens) {
    findings.push({
      severity: "warn",
      code: "always_on_budget_high",
      value: alwaysOnEstimatedTokens,
      limit: policies.knowledgeBudget.alwaysOnHardLimitTokens,
      message: `Always-on rules estimated at ${alwaysOnEstimatedTokens} tokens (>= warn ${policies.knowledgeBudget.alwaysOnWarnTokens})`,
    });
  }

  const feedbackPath = join(cursorRoot, "feedback-log.md");
  let feedbackLogLines = 0;
  if (existsSync(feedbackPath)) {
    feedbackLogLines = readFileSync(feedbackPath, "utf8").split("\n").length;
    if (feedbackLogLines > policies.knowledgeBudget.feedbackLogWarnLines) {
      findings.push({
        severity: "warn",
        code: "feedback_log_long",
        path: feedbackPath,
        value: feedbackLogLines,
        limit: policies.knowledgeBudget.feedbackLogWarnLines,
        message: `feedback-log.md has ${feedbackLogLines} lines; consider consolidating into rules/kits`,
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    canSync: !findings.some((f) => f.severity === "block"),
    alwaysOnBytes,
    alwaysOnEstimatedTokens,
    feedbackLogLines,
    findings,
  };
}

export type GuardDecision =
  | { action: "ok" }
  | { action: "warn"; code: string; message: string }
  | { action: "abort"; code: string; message: string };

export class TaskGuard {
  private fileEdits = new Map<string, number[]>();
  private failingCmdCounts = new Map<string, number>();
  private lastFailingCmd?: string;
  private consecutiveFailingCmd = 0;
  private readOnlyStreak = 0;
  private totalSteps = 0;
  private totalTurns = 0;
  private totalChars = 0;

  constructor(
    private readonly policies: PoliciesConfig,
    private readonly isLargeTask = false
  ) {}

  recordFileEdit(filePath: string, now = Date.now()): GuardDecision {
    this.totalSteps += 1;
    this.readOnlyStreak = 0;
    const windowMs = this.policies.loopGuard.repeatedFileEditWindowMs;
    const list = (this.fileEdits.get(filePath) ?? []).filter((t) => now - t <= windowMs);
    list.push(now);
    this.fileEdits.set(filePath, list);

    if (list.length >= this.policies.loopGuard.repeatedFileEditAbort) {
      return {
        action: "abort",
        code: "repeated_file_edit",
        message: `File ${filePath} edited ${list.length} times within window`,
      };
    }
    if (list.length >= this.policies.loopGuard.repeatedFileEditWarn) {
      return {
        action: "warn",
        code: "repeated_file_edit",
        message: `File ${filePath} edited ${list.length} times within window`,
      };
    }
    return this.checkStepBudget();
  }

  recordCommandResult(cmdSignature: string, exitCode: number): GuardDecision {
    this.totalSteps += 1;
    if (exitCode === 0) {
      this.consecutiveFailingCmd = 0;
      this.lastFailingCmd = undefined;
      return this.checkStepBudget();
    }
    const key = `${cmdSignature}::${exitCode}`;
    const count = (this.failingCmdCounts.get(key) ?? 0) + 1;
    this.failingCmdCounts.set(key, count);
    this.consecutiveFailingCmd = this.lastFailingCmd === key ? this.consecutiveFailingCmd + 1 : 1;
    this.lastFailingCmd = key;

    if (
      this.consecutiveFailingCmd >= this.policies.loopGuard.repeatedFailingCmdAbortConsecutive ||
      count >= this.policies.loopGuard.repeatedFailingCmdAbortPerTask
    ) {
      return {
        action: "abort",
        code: "repeated_failing_cmd",
        message: `Command failed repeatedly (${count} total, ${this.consecutiveFailingCmd} consecutive)`,
      };
    }
    if (this.consecutiveFailingCmd >= this.policies.loopGuard.repeatedFailingCmdWarn) {
      return {
        action: "warn",
        code: "repeated_failing_cmd",
        message: `Command failed ${this.consecutiveFailingCmd} times in a row`,
      };
    }
    return this.checkStepBudget();
  }

  recordReadOnlyTool(): GuardDecision {
    this.totalSteps += 1;
    this.readOnlyStreak += 1;
    if (this.readOnlyStreak >= this.policies.loopGuard.noProgressToolBurstAbort) {
      return {
        action: "abort",
        code: "no_progress_burst",
        message: `${this.readOnlyStreak} consecutive read-only tool calls without progress`,
      };
    }
    return this.checkStepBudget();
  }

  recordTurnChars(chars: number): GuardDecision {
    this.totalTurns += 1;
    this.totalChars += chars;
    const estTokens = Math.ceil(this.totalChars / this.policies.contextGuard.charsPerTokenEstimate);
    if (
      this.totalTurns >= this.policies.contextGuard.abortTurns ||
      this.totalChars >= this.policies.contextGuard.abortChars
    ) {
      return {
        action: "abort",
        code: "context_bloat_red",
        message: `Context red threshold reached (${this.totalTurns} turns, ~${estTokens} est. tokens)`,
      };
    }
    if (
      this.totalTurns >= this.policies.contextGuard.warnTurns ||
      this.totalChars >= this.policies.contextGuard.warnChars
    ) {
      return {
        action: "warn",
        code: "context_bloat_yellow",
        message: `Context yellow warning (${this.totalTurns} turns, ~${estTokens} est. tokens)`,
      };
    }
    return { action: "ok" };
  }

  private checkStepBudget(): GuardDecision {
    const maxSteps = this.isLargeTask
      ? this.policies.loopGuard.maxStepsLarge
      : this.policies.loopGuard.maxStepsNormal;
    if (this.totalSteps > maxSteps) {
      return {
        action: "abort",
        code: "max_steps_exceeded",
        message: `Exceeded max steps (${this.totalSteps}/${maxSteps})`,
      };
    }
    return { action: "ok" };
  }
}
