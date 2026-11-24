import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DiscoveredAgent } from "../../../packages/protocol/src/events.ts";

export interface KnowledgeHubStatus {
  root: string;
  exists: boolean;
  pluginVersion?: string;
  coreRuleBytes?: number;
  coreRuleWithin24KB?: boolean;
  skillsCount: number;
  projectKits: string[];
  syncAntigravityScriptExists: boolean;
}

export interface DiscoveryReport {
  scannedAt: string;
  host: {
    platform: string;
    arch: string;
    bunVersion: string;
  };
  agents: DiscoveredAgent[];
  knowledgeHub: KnowledgeHubStatus;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function resolveExecutable(candidates: string[]): string | undefined {
  for (const raw of candidates) {
    const p = expandHome(raw);
    if (p.includes("/")) {
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        // ignore broken symlinks
      }
    } else {
      const found = Bun.which(p);
      if (found) return found;
    }
  }
  return undefined;
}

function getVersion(binPath: string): string | undefined {
  try {
    const proc = Bun.spawnSync([binPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim().split("\n")[0];
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function scanKnowledgeHub(): KnowledgeHubStatus {
  const root = join(homedir(), ".cursor");
  if (!existsSync(root)) {
    return {
      root,
      exists: false,
      skillsCount: 0,
      projectKits: [],
      syncAntigravityScriptExists: false,
    };
  }

  let pluginVersion: string | undefined;
  const pluginJson = join(
    root,
    "plugins/local/lyvan-global/.cursor-plugin/plugin.json"
  );
  if (existsSync(pluginJson)) {
    try {
      const parsed = JSON.parse(readFileSync(pluginJson, "utf8"));
      pluginVersion = typeof parsed.version === "string" ? parsed.version : undefined;
    } catch {
      // ignore
    }
  }

  let coreRuleBytes: number | undefined;
  const coreRulePath = join(root, "plugins/local/lyvan-global/rules/core.mdc");
  if (existsSync(coreRulePath)) {
    coreRuleBytes = statSync(coreRulePath).size;
  }

  const skillsDir = join(root, "skills");
  let skillsCount = 0;
  if (existsSync(skillsDir)) {
    skillsCount = readdirSync(skillsDir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && !d.name.startsWith(".")
    ).length;
  }

  const kitsDir = join(root, "project-kits");
  let projectKits: string[] = [];
  if (existsSync(kitsDir)) {
    projectKits = readdirSync(kitsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  }

  const syncScript = join(root, "scripts/sync-antigravity.sh");

  return {
    root,
    exists: true,
    pluginVersion,
    coreRuleBytes,
    coreRuleWithin24KB:
      coreRuleBytes !== undefined ? coreRuleBytes <= 24 * 1024 : undefined,
    skillsCount,
    projectKits,
    syncAntigravityScriptExists: existsSync(syncScript),
  };
}

export function runDiscovery(): DiscoveryReport {
  const agents: DiscoveredAgent[] = [];

  // 1. Antigravity (agy)
  const agyBin = resolveExecutable([
    "agy",
    "~/.gemini/bin/agy",
    "~/.antigravity/antigravity/bin/agy",
  ]);
  const agyVersion = agyBin ? getVersion(agyBin) : undefined;
  agents.push({
    id: "antigravity-default",
    provider: "antigravity",
    displayName: agyVersion ? `Antigravity CLI (${agyVersion})` : "Antigravity CLI",
    binaryPath: agyBin,
    configPath: existsSync(expandHome("~/.gemini")) ? expandHome("~/.gemini") : undefined,
    ready: Boolean(agyBin),
    reason: agyBin
      ? "Ready for headless stream-json (--input-format stream-json --output-format stream-json)"
      : "agy binary not found",
  });

  // 2. Cursor Agent CLI
  const cursorAgentBin = resolveExecutable([
    "agent",
    "~/.local/bin/agent",
    "/usr/local/bin/agent",
  ]);
  const cursorAppExists = existsSync("/Applications/Cursor.app");
  const cursorConfigExists = existsSync(expandHome("~/.cursor"));
  agents.push({
    id: "cursor-default",
    provider: "cursor",
    displayName: "Cursor Agent CLI",
    binaryPath: cursorAgentBin,
    configPath: cursorConfigExists ? expandHome("~/.cursor") : undefined,
    ready: Boolean(cursorAgentBin),
    reason: cursorAgentBin
      ? "Ready for headless stream-json"
      : cursorAppExists
        ? "Cursor.app installed, standalone 'agent' CLI not in PATH yet"
        : "Cursor not found",
  });

  // 3. Codex CLI
  const codexBin = resolveExecutable(["codex", "~/.local/bin/codex", "/opt/homebrew/bin/codex"]);
  const codexConfigExists = existsSync(expandHome("~/.codex"));
  agents.push({
    id: "codex-default",
    provider: "codex",
    displayName: "OpenAI Codex CLI",
    binaryPath: codexBin,
    configPath: codexConfigExists ? expandHome("~/.codex") : undefined,
    ready: Boolean(codexBin),
    reason: codexBin
      ? "Ready for codex app-server / exec --json"
      : codexConfigExists
        ? "~/.codex config detected, standalone 'codex' CLI not in PATH yet"
        : "Codex not found",
  });

  return {
    scannedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
    },
    agents,
    knowledgeHub: scanKnowledgeHub(),
  };
}
