import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OfficeDatabase } from "./db.ts";
import type { KnowledgeLibrary } from "./library.ts";

export interface Finding {
  severity: "info" | "warning" | "critical";
  code: string;
  path?: string;
  message: string;
  estSavedTokens?: number;
}

export interface AuditReport {
  id: string;
  at: string;
  kind: "rule" | "ai";
  totals: {
    files: number;
    tokens: number;
    alwaysLoadedTokens: number;
  };
  findings: Finding[];
  aiSummary?: string;
}

export class AuditRateLimitError extends Error {
  readonly status = 429;
  constructor(message = "AI audit is rate-limited to once per 10 minutes") {
    super(message);
    this.name = "AuditRateLimitError";
  }
}

const MAX_HISTORY = 20;
const ALWAYS_LOADED_BIG_TOKENS = 800;
const SKILL_BIG_TOKENS = 2500;
const DUPLICATE_MIN_CHARS = 200;
const BACKUP_PILEUP_THRESHOLD = 7;
const BUDGET_OVER_TOKENS = 20_000;
const AI_RATE_LIMIT_MS = 10 * 60 * 1000;
const AI_SPAWN_TIMEOUT_MS = 130_000;

function hasAlwaysApplyFrontmatter(content: string): boolean {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return false;
  return /^\s*alwaysApply\s*:\s*true\s*$/m.test(match[1]);
}

function countBackupDirs(root: string): number {
  if (!existsSync(root)) return 0;
  try {
    const entries = readdirSync(root, { withFileTypes: true }) as Array<{
      isDirectory(): boolean;
      name: string;
    }>;
    return entries.filter((d) => d.isDirectory() && d.name.startsWith("backup-")).length;
  } catch {
    return 0;
  }
}

export class AuditService {
  private history: AuditReport[] = [];
  private lastAiRunAt = 0;
  private initialTimer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly library: KnowledgeLibrary,
    private readonly db?: OfficeDatabase,
    private readonly onReport?: (report: AuditReport) => void
  ) {
    if (this.db) {
      const persisted = this.db.getLatestAuditReport<AuditReport>();
      if (persisted) {
        this.history.push(persisted);
      }
    }
  }

  getLatest(): AuditReport | null {
    if (this.history.length > 0) {
      return this.history[this.history.length - 1];
    }
    if (this.db) {
      const persisted = this.db.getLatestAuditReport<AuditReport>();
      if (persisted) {
        this.history.push(persisted);
        return persisted;
      }
    }
    return null;
  }

  getHistory(): AuditReport[] {
    return [...this.history];
  }

  private recordReport(report: AuditReport): AuditReport {
    this.history.push(report);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    if (this.db) {
      try {
        this.db.saveAuditReport(report);
      } catch {
        // do not fail audit if persistence fails
      }
    }
    if (this.onReport) {
      try {
        this.onReport(report);
      } catch {
        // isolate subscriber errors
      }
    }
    return report;
  }

  runRuleAudit(options?: { record?: boolean }): AuditReport {
    const tree = this.library.listTree();
    const findings: Finding[] = [];
    let totalTokens = 0;
    let alwaysLoadedTokens = 0;

    // Map trimmed paragraph (>=200 chars) -> set of file paths
    const paragraphFiles = new Map<string, Set<string>>();

    for (const entry of tree.entries) {
      totalTokens += entry.tokens;

      let content: string;
      try {
        content = this.library.readFile(entry.path).content;
      } catch {
        continue;
      }

      if (entry.area === "rules" && hasAlwaysApplyFrontmatter(content)) {
        alwaysLoadedTokens += entry.tokens;
        if (entry.tokens > ALWAYS_LOADED_BIG_TOKENS) {
          findings.push({
            severity: "warning",
            code: "ALWAYS_LOADED_BIG",
            path: entry.path,
            message: `Always-loaded rule has ${entry.tokens} tokens (threshold: ${ALWAYS_LOADED_BIG_TOKENS})`,
            estSavedTokens: entry.tokens - ALWAYS_LOADED_BIG_TOKENS,
          });
        }
      }

      if (entry.area === "skills" && entry.tokens > SKILL_BIG_TOKENS) {
        findings.push({
          severity: "warning",
          code: "SKILL_BIG",
          path: entry.path,
          message: `Skill file has ${entry.tokens} tokens (threshold: ${SKILL_BIG_TOKENS})`,
          estSavedTokens: entry.tokens - SKILL_BIG_TOKENS,
        });
      }

      const paragraphs = content.split(/\r?\n\s*\r?\n/);
      for (const rawPara of paragraphs) {
        const para = rawPara.trim();
        if (para.length < DUPLICATE_MIN_CHARS) continue;
        let files = paragraphFiles.get(para);
        if (!files) {
          files = new Set<string>();
          paragraphFiles.set(para, files);
        }
        files.add(entry.path);
      }
    }

    for (const [para, filesSet] of paragraphFiles.entries()) {
      if (filesSet.size < 2) continue;
      const files = Array.from(filesSet).sort();
      const estSavedTokens = Math.ceil((para.length * (files.length - 1)) / 4);
      findings.push({
        severity: "warning",
        code: "DUPLICATE_BLOCK",
        path: files[0],
        message: `Duplicate paragraph (${para.length} chars) appears in ${files.length} files: ${files.join(", ")}`,
        estSavedTokens,
      });
    }

    const backupCount = countBackupDirs(this.library.root);
    if (backupCount > BACKUP_PILEUP_THRESHOLD) {
      findings.push({
        severity: "info",
        code: "BACKUP_PILEUP",
        message: `Found ${backupCount} backup-* directories in knowledge root (threshold: ${BACKUP_PILEUP_THRESHOLD})`,
      });
    }

    if (alwaysLoadedTokens > BUDGET_OVER_TOKENS) {
      findings.push({
        severity: "critical",
        code: "BUDGET_OVER",
        message: `Always-loaded rules total ${alwaysLoadedTokens} tokens, exceeding ${BUDGET_OVER_TOKENS} token budget`,
        estSavedTokens: alwaysLoadedTokens - BUDGET_OVER_TOKENS,
      });
    }

    const report: AuditReport = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      kind: "rule",
      totals: {
        files: tree.entries.length,
        tokens: totalTokens,
        alwaysLoadedTokens,
      },
      findings,
    };

    if (options?.record === false) {
      return report;
    }
    return this.recordReport(report);
  }

  async runAiAudit(): Promise<AuditReport> {
    const now = Date.now();
    if (this.lastAiRunAt > 0 && now - this.lastAiRunAt < AI_RATE_LIMIT_MS) {
      const waitSec = Math.ceil((AI_RATE_LIMIT_MS - (now - this.lastAiRunAt)) / 1000);
      throw new AuditRateLimitError(
        `AI audit rate-limited (max once per 10 minutes). Try again in ${waitSec}s.`
      );
    }
    this.lastAiRunAt = now;

    const ruleReport = this.runRuleAudit({ record: false });
    const agyBin = join(homedir(), ".gemini", "bin", "agy");

    const prompt = [
      "Bạn là chuyên gia tối ưu ngữ cảnh cho AI coding agents.",
      "Dưới đây là JSON báo cáo rule audit (chỉ gồm đường dẫn và số liệu, không có nội dung file).",
      "Hãy đưa ra tối đa 8 gạch đầu dòng bằng tiếng Việt, ngắn gọn và cụ thể, để cắt gọn rules/skills và định tuyến model hiệu quả hơn:",
      "",
      JSON.stringify(ruleReport),
    ].join("\n");

    let proc;
    try {
      proc = Bun.spawn(
        [
          agyBin,
          "--print",
          "--output-format",
          "text",
          "--effort",
          "low",
          "--mode",
          "plan",
          "--print-timeout",
          "120s",
          prompt,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.recordReport({
        ...ruleReport,
        aiSummary: `AI audit spawn failed: ${msg}`,
      });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, AI_SPAWN_TIMEOUT_MS);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (timedOut) {
        return this.recordReport({
          ...ruleReport,
          aiSummary: "AI audit timed out after 130s",
        });
      }

      const trimmedOut = stdout.trim();
      if (exitCode !== 0 || !trimmedOut) {
        const errDetail = stderr.trim() || `exit code ${exitCode}`;
        return this.recordReport({
          ...ruleReport,
          aiSummary: `AI audit failed: ${errDetail}`,
        });
      }

      return this.recordReport({
        ...ruleReport,
        kind: "ai",
        aiSummary: trimmedOut,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.recordReport({
        ...ruleReport,
        aiSummary: `AI audit error: ${msg}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  startScheduler(): void {
    const rawMin = process.env.AUDIT_INTERVAL_MIN;
    const intervalMin = rawMin !== undefined ? Number(rawMin) : 360;
    if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
      return;
    }

    this.initialTimer = setTimeout(() => {
      try {
        this.runRuleAudit();
      } catch {
        // ignore background audit errors
      }
      this.intervalTimer = setInterval(() => {
        try {
          this.runRuleAudit();
        } catch {
          // ignore background audit errors
        }
      }, intervalMin * 60 * 1000);
    }, 10_000);
  }

  stopScheduler(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
  }
}
