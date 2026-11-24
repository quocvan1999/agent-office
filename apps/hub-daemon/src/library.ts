import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, posix, resolve, sep } from "node:path";

export type LibArea = "rules" | "kits" | "skills" | "agents" | "hooks" | "feedback";

export interface LibEntry {
  path: string;
  area: LibArea;
  size: number;
  tokens: number;
  mtime: string;
}

export interface LibTreeResponse {
  root: string;
  writable: boolean;
  entries: LibEntry[];
}

export interface LibFileResponse {
  path: string;
  content: string;
  tokens: number;
  mtime: string;
}

export interface LibWriteResult {
  ok: true;
  backupPath: string;
  pluginVersion: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface LibSyncResult {
  ok: boolean;
  dryRun: boolean;
  exitCode: number;
  output: string;
  skipped?: string;
}

export class LibraryError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

const MAX_FILE_BYTES = 512 * 1024;
const SYNC_TIMEOUT_MS = 60_000;
const SYNC_MAX_OUTPUT_CHARS = 8_000;

const RULES_ALLOWED_EXTS = new Set([".mdc", ".md", ".json"]);

const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".wav",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".bin",
  ".pyc",
  ".class",
  ".jar",
  ".wasm",
]);

const SENSITIVE_NAME_RE = /(secret|token|key|credential|password|keystore)/i;

const PLUGIN_JSON_REL = "plugins/local/lyvan-global/.cursor-plugin/plugin.json";
const FEEDBACK_LOG_REL = "feedback-log.md";

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateParts(now = new Date()): { date: string; timeCompact: string; timeColon: string } {
  const y = now.getFullYear();
  const mo = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const h = pad2(now.getHours());
  const mi = pad2(now.getMinutes());
  const s = pad2(now.getSeconds());
  return {
    date: `${y}-${mo}-${d}`,
    timeCompact: `${h}${mi}${s}`,
    timeColon: `${h}:${mi}`,
  };
}

function isHardDeniedSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (lower === "mcp.json") return true;
  if (lower === "cli-config.json") return true;
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (lower.endsWith(".pem") || lower.endsWith(".p12")) return true;
  if (SENSITIVE_NAME_RE.test(segment)) return true;
  return false;
}

function isSkippedDirName(name: string): boolean {
  return name === "node_modules" || name === ".git" || name.startsWith("backup-");
}

function isTextBuffer(buf: Uint8Array, filePath: string): boolean {
  const name = basename(filePath);
  if (name === ".DS_Store") return false;
  const ext = extname(name).toLowerCase();
  if (BINARY_EXTS.has(ext)) return false;
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

function classifyAllowedArea(relPosix: string): LibArea | null {
  if (relPosix === FEEDBACK_LOG_REL) return "feedback";
  if (relPosix === "hooks.json" || relPosix.startsWith("hooks/")) return "hooks";
  if (relPosix.startsWith("plugins/local/lyvan-global/")) {
    const ext = extname(relPosix).toLowerCase();
    return RULES_ALLOWED_EXTS.has(ext) ? "rules" : null;
  }
  if (relPosix.startsWith("project-kits/")) return "kits";
  if (relPosix.startsWith("skills/")) return "skills";
  if (relPosix.startsWith("agents/")) return "agents";
  return null;
}

function normalizeRelPosix(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new LibraryError(400, "Missing or empty path");
  }
  if (raw.includes("\0") || raw.includes("\\")) {
    throw new LibraryError(403, "Invalid path characters");
  }
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new LibraryError(403, "Absolute paths are not allowed");
  }
  const segments = raw.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new LibraryError(403, "Path traversal or invalid segment rejected");
    }
  }
  const normalized = posix.normalize(raw);
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    throw new LibraryError(403, "Path escape rejected");
  }
  return normalized;
}

function atomicWriteUtf8(targetPath: string, content: string): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(
    dir,
    `.tmp-hub-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export interface KnowledgeLibraryOptions {
  root?: string;
  writable?: boolean;
}

export class KnowledgeLibrary {
  readonly root: string;
  private readonly writableOverride?: boolean;

  constructor(options?: KnowledgeLibraryOptions) {
    const rawRoot = options?.root ?? process.env.KNOWLEDGE_ROOT ?? join(homedir(), ".cursor");
    this.root = resolve(expandHome(rawRoot));
    this.writableOverride = options?.writable;
  }

  isWritable(): boolean {
    if (this.writableOverride !== undefined) return this.writableOverride;
    return process.env.LIBRARY_WRITE !== "0";
  }

  private getRealRoot(): string {
    if (!existsSync(this.root)) return this.root;
    return realpathSync(this.root);
  }

  private isInsideRealRoot(realTarget: string, realRoot: string): boolean {
    return realTarget === realRoot || realTarget.startsWith(realRoot + sep);
  }

  private assertAllowedAndSafePath(
    rawRel: string,
    mode: "read" | "write"
  ): { rel: string; area: LibArea; absPath: string } {
    const rel = normalizeRelPosix(rawRel);
    const segments = rel.split("/");

    for (const seg of segments) {
      if (isHardDeniedSegment(seg)) {
        throw new LibraryError(403, `Access denied for path: ${rel}`);
      }
      if (isSkippedDirName(seg)) {
        throw new LibraryError(403, `Access denied for skipped directory: ${rel}`);
      }
    }

    const area = classifyAllowedArea(rel);
    if (!area) {
      throw new LibraryError(403, `Path is outside allowed library areas: ${rel}`);
    }

    const realRoot = this.getRealRoot();
    const absPath = resolve(this.root, ...segments);

    if (!this.isInsideRealRoot(absPath, this.root) && !this.isInsideRealRoot(absPath, realRoot)) {
      throw new LibraryError(403, "Path escapes knowledge root");
    }

    if (mode === "read") {
      if (!existsSync(absPath)) {
        throw new LibraryError(404, `File not found: ${rel}`);
      }
      const realTarget = realpathSync(absPath);
      if (!this.isInsideRealRoot(realTarget, realRoot)) {
        throw new LibraryError(403, "Symlink escapes knowledge root");
      }
    } else {
      // For write: if target exists (or is a symlink), verify its realpath is inside root.
      // Otherwise walk up to the nearest existing ancestor and verify its realpath is inside root.
      let probe = absPath;
      let checkedTarget = false;
      try {
        lstatSync(absPath);
        checkedTarget = true;
      } catch {
        checkedTarget = false;
      }

      if (checkedTarget) {
        let realTarget: string;
        try {
          realTarget = realpathSync(absPath);
        } catch {
          throw new LibraryError(403, "Broken or escaping symlink rejected");
        }
        if (!this.isInsideRealRoot(realTarget, realRoot)) {
          throw new LibraryError(403, "Symlink escapes knowledge root");
        }
      } else {
        probe = dirname(absPath);
        while (!existsSync(probe)) {
          const parent = dirname(probe);
          if (parent === probe) break;
          probe = parent;
        }
        if (existsSync(probe)) {
          const realAncestor = realpathSync(probe);
          if (!this.isInsideRealRoot(realAncestor, realRoot)) {
            throw new LibraryError(403, "Target directory escapes knowledge root");
          }
        }
      }
    }

    return { rel, area, absPath };
  }

  listTree(): LibTreeResponse {
    const entries: LibEntry[] = [];
    if (!existsSync(this.root)) {
      return { root: this.root, writable: this.isWritable(), entries };
    }

    const realRoot = this.getRealRoot();

    const maybeAddFile = (relPosix: string, area: LibArea) => {
      const segments = relPosix.split("/");
      for (const seg of segments) {
        if (isHardDeniedSegment(seg) || isSkippedDirName(seg)) return;
      }
      if (area === "rules" && !RULES_ALLOWED_EXTS.has(extname(relPosix).toLowerCase())) {
        return;
      }

      const absPath = join(this.root, ...segments);
      if (!existsSync(absPath)) return;

      let realTarget: string;
      let st;
      try {
        realTarget = realpathSync(absPath);
        if (!this.isInsideRealRoot(realTarget, realRoot)) return;
        st = statSync(realTarget);
      } catch {
        return;
      }

      if (!st.isFile()) return;
      if (st.size > MAX_FILE_BYTES) return;

      let buf: Buffer;
      try {
        buf = readFileSync(realTarget);
      } catch {
        return;
      }
      if (!isTextBuffer(buf, relPosix)) return;

      const content = buf.toString("utf8");
      entries.push({
        path: relPosix,
        area,
        size: st.size,
        tokens: estimateTokens(content),
        mtime: st.mtime.toISOString(),
      });
    };

    const walkDir = (relDirPosix: string, area: LibArea, visitedRealDirs: Set<string>) => {
      const absDir = join(this.root, ...relDirPosix.split("/"));
      if (!existsSync(absDir)) return;

      let realDir: string;
      try {
        realDir = realpathSync(absDir);
        if (!this.isInsideRealRoot(realDir, realRoot)) return;
        if (!statSync(realDir).isDirectory()) return;
      } catch {
        return;
      }

      if (visitedRealDirs.has(realDir)) return;
      visitedRealDirs.add(realDir);

      let dirEntries;
      try {
        dirEntries = readdirSync(realDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const dirent of dirEntries) {
        const name = dirent.name;
        if (isSkippedDirName(name) || isHardDeniedSegment(name)) continue;

        const childRel = `${relDirPosix}/${name}`;
        const childAbs = join(this.root, ...childRel.split("/"));

        let childReal: string;
        let childStat;
        try {
          childReal = realpathSync(childAbs);
          if (!this.isInsideRealRoot(childReal, realRoot)) continue;
          childStat = statSync(childReal);
        } catch {
          continue;
        }

        if (childStat.isDirectory()) {
          walkDir(childRel, area, visitedRealDirs);
        } else if (childStat.isFile()) {
          maybeAddFile(childRel, area);
        }
      }
    };

    const visited = new Set<string>();
    walkDir("plugins/local/lyvan-global", "rules", visited);
    walkDir("project-kits", "kits", visited);
    walkDir("skills", "skills", visited);
    walkDir("agents", "agents", visited);
    walkDir("hooks", "hooks", visited);
    maybeAddFile("hooks.json", "hooks");
    maybeAddFile(FEEDBACK_LOG_REL, "feedback");

    entries.sort((a, b) => a.path.localeCompare(b.path));
    return {
      root: this.root,
      writable: this.isWritable(),
      entries,
    };
  }

  readFile(rawRel: string): LibFileResponse {
    const { rel, absPath } = this.assertAllowedAndSafePath(rawRel, "read");
    const st = statSync(absPath);
    if (!st.isFile()) {
      throw new LibraryError(400, `Not a regular file: ${rel}`);
    }
    if (st.size > MAX_FILE_BYTES) {
      throw new LibraryError(413, `File exceeds 512KB limit: ${rel}`);
    }
    const buf = readFileSync(absPath);
    if (!isTextBuffer(buf, rel)) {
      throw new LibraryError(415, `Binary files are not supported: ${rel}`);
    }
    const content = buf.toString("utf8");
    return {
      path: rel,
      content,
      tokens: estimateTokens(content),
      mtime: st.mtime.toISOString(),
    };
  }

  writeFile(input: {
    path: string;
    content: string;
    note: string;
    expectedMtime?: string;
  }): LibWriteResult {
    if (!this.isWritable()) {
      throw new LibraryError(403, "Library is read-only (LIBRARY_WRITE=0)");
    }

    if (typeof input.content !== "string") {
      throw new LibraryError(400, "Field 'content' must be a string");
    }
    if (input.content.includes("\0")) {
      throw new LibraryError(400, "Binary content is not allowed");
    }
    if (Buffer.byteLength(input.content, "utf8") > MAX_FILE_BYTES) {
      throw new LibraryError(413, "Content exceeds 512KB limit");
    }

    if (typeof input.note !== "string") {
      throw new LibraryError(400, "Field 'note' is required");
    }
    const cleanNote = input.note.replace(/[\r\n]+/g, " ").trim();
    if (cleanNote.length < 3 || cleanNote.length > 200) {
      throw new LibraryError(400, "Field 'note' must be between 3 and 200 characters");
    }

    const { rel, absPath } = this.assertAllowedAndSafePath(input.path, "write");

    const now = new Date();
    const { date, timeCompact, timeColon } = formatDateParts(now);
    const backupBaseDir = join(this.root, `backup-${date}`, `hub-${timeCompact}`);

    let tokensBefore = 0;
    let backupPath = "";

    const existed = existsSync(absPath);
    if (existed) {
      const st = statSync(absPath);
      if (!st.isFile()) {
        throw new LibraryError(400, `Target is not a file: ${rel}`);
      }
      if (input.expectedMtime && st.mtime.toISOString() !== input.expectedMtime) {
        throw new LibraryError(409, "File has been modified concurrently (expectedMtime mismatch)");
      }
      const oldContent = readFileSync(absPath, "utf8");
      tokensBefore = estimateTokens(oldContent);

      // (a) Backup existing file
      backupPath = join(backupBaseDir, ...rel.split("/"));
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(absPath, backupPath);
    }

    // (b) Atomic write
    atomicWriteUtf8(absPath, input.content);
    const tokensAfter = estimateTokens(input.content);

    // (c) Bump patch semver in plugin.json
    const pluginVersion = this.bumpPluginVersion(backupBaseDir, rel === PLUGIN_JSON_REL);

    // (d) Append one line to feedback-log.md (unless editing feedback-log.md itself)
    if (rel !== FEEDBACK_LOG_REL) {
      this.appendFeedbackLog(date, timeColon, rel, cleanNote);
    }

    return {
      ok: true,
      backupPath,
      pluginVersion,
      tokensBefore,
      tokensAfter,
    };
  }

  private bumpPluginVersion(backupBaseDir: string, alreadyBackedUp: boolean): string {
    const pluginAbs = join(this.root, ...PLUGIN_JSON_REL.split("/"));
    if (!existsSync(pluginAbs)) {
      return "n/a";
    }

    let raw: string;
    try {
      raw = readFileSync(pluginAbs, "utf8");
    } catch {
      return "n/a";
    }

    const versionMatch = raw.match(/("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)([^"]*")/);
    if (!versionMatch) {
      return "n/a";
    }

    if (!alreadyBackedUp) {
      const pluginBackup = join(backupBaseDir, ...PLUGIN_JSON_REL.split("/"));
      mkdirSync(dirname(pluginBackup), { recursive: true });
      copyFileSync(pluginAbs, pluginBackup);
    }

    const major = versionMatch[2];
    const minor = versionMatch[3];
    const nextPatch = Number(versionMatch[4]) + 1;
    const suffix = versionMatch[5]; // includes closing quote
    const nextVersion = `${major}.${minor}.${nextPatch}${suffix.slice(0, -1)}`;
    const updated = raw.replace(
      /("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)([^"]*")/,
      `$1${major}.${minor}.${nextPatch}$5`
    );

    atomicWriteUtf8(pluginAbs, updated);
    return nextVersion;
  }

  private appendFeedbackLog(date: string, timeColon: string, rel: string, note: string): void {
    const feedbackAbs = join(this.root, FEEDBACK_LOG_REL);
    const line = `- ${date} ${timeColon} [agent-office] edited ${rel}: ${note}\n`;
    if (existsSync(feedbackAbs)) {
      const existing = readFileSync(feedbackAbs, "utf8");
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      appendFileSync(feedbackAbs, `${prefix}${line}`, "utf8");
    } else {
      atomicWriteUtf8(feedbackAbs, line);
    }
  }

  private isRealCursorRoot(): boolean {
    const defaultCursor = resolve(join(homedir(), ".cursor"));
    try {
      const realCurrent = existsSync(this.root) ? realpathSync(this.root) : this.root;
      const realDefault = existsSync(defaultCursor) ? realpathSync(defaultCursor) : defaultCursor;
      return realCurrent === realDefault;
    } catch {
      return this.root === defaultCursor;
    }
  }

  async sync(options?: { dryRun?: boolean }): Promise<LibSyncResult> {
    const dryRun = options?.dryRun !== false;

    if (!this.isRealCursorRoot()) {
      return {
        ok: true,
        dryRun,
        exitCode: 0,
        output: "",
        skipped: "KNOWLEDGE_ROOT is not ~/.cursor",
      };
    }

    const scriptPath = join(this.root, "scripts", "sync-antigravity.sh");
    if (!existsSync(scriptPath)) {
      return {
        ok: false,
        dryRun,
        exitCode: 127,
        output: `Sync script not found: ${scriptPath}`,
      };
    }

    const cmd = dryRun ? [scriptPath, "--dry-run"] : [scriptPath];
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, SYNC_TIMEOUT_MS);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      const combined = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
      const suffix = timedOut ? "\n[sync timed out after 60s]" : "";
      const fullOutput = `${combined}${suffix}`;
      const output =
        fullOutput.length > SYNC_MAX_OUTPUT_CHARS
          ? `${fullOutput.slice(0, SYNC_MAX_OUTPUT_CHARS - 16)}\n...[truncated]`
          : fullOutput;

      return {
        ok: !timedOut && exitCode === 0,
        dryRun,
        exitCode: timedOut ? 124 : exitCode,
        output,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
