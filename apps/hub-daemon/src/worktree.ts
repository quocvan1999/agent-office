import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureDataDirLayout } from "./policy.ts";

export interface WorktreeInfo {
  taskId: string;
  branch: string;
  path: string;
  repoPath: string;
}

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
}

export class WorktreeManager {
  readonly baseDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir = customBaseDir ?? join(ensureDataDirLayout(), "worktrees");
    mkdirSync(this.baseDir, { recursive: true });
  }

  createWorktree(repoPath: string, taskId: string, baseRef = "HEAD"): WorktreeInfo {
    const safeTask = sanitize(taskId);
    const repoSlug = sanitize(basename(repoPath));
    const branch = `agent-office/${safeTask}`;
    const targetPath = join(this.baseDir, `${repoSlug}-${safeTask}`);

    if (existsSync(targetPath)) {
      throw new Error(`Worktree path already exists: ${targetPath}`);
    }

    const proc = Bun.spawnSync(
      ["git", "-C", repoPath, "worktree", "add", "-b", branch, targetPath, baseRef],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (proc.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${proc.stderr.toString().trim()}`);
    }

    return { taskId: safeTask, branch, path: targetPath, repoPath };
  }

  getDiffStat(worktreePath: string): string {
    const proc = Bun.spawnSync(["git", "-C", worktreePath, "status", "--short"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.stdout.toString().trim();
  }

  removeWorktree(repoPath: string, info: WorktreeInfo): void {
    const rmProc = Bun.spawnSync(
      ["git", "-C", repoPath, "worktree", "remove", "--force", info.path],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (rmProc.exitCode !== 0) {
      throw new Error(`git worktree remove failed: ${rmProc.stderr.toString().trim()}`);
    }
    Bun.spawnSync(["git", "-C", repoPath, "branch", "-D", info.branch], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }
}
