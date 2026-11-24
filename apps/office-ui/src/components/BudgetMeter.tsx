import type { KnowledgeLintReport, PolicyBudget } from "../types.ts";

export default function BudgetMeter({ lint, budget }: { lint: KnowledgeLintReport | null; budget: PolicyBudget }) {
  if (!lint) return <div className="budget muted">~/.cursor: đang đo…</div>;
  const used = lint.alwaysOnEstimatedTokens;
  const hard = budget.alwaysOnHardLimitTokens;
  const pct = Math.min(100, (used / hard) * 100);
  const level = used >= budget.alwaysOnBlockTokens || !lint.canSync ? "block" : used >= budget.alwaysOnWarnTokens ? "warn" : "ok";
  const problems = lint.findings.filter((f) => f.severity !== "ok");
  const tip = [
    `Always-on ≈ ${used.toLocaleString("vi-VN")} / ${hard.toLocaleString("vi-VN")} token`,
    `Cảnh báo ≥ ${budget.alwaysOnWarnTokens.toLocaleString("vi-VN")} · chặn sync ≥ ${budget.alwaysOnBlockTokens.toLocaleString("vi-VN")}`,
    `feedback-log.md: ${lint.feedbackLogLines} dòng`,
    `canSync: ${lint.canSync ? "có" : "KHÔNG"}`,
    ...problems.map((f) => `[${f.severity}] ${f.message}`),
  ].join("\n");
  return (
    <div className={`budget ${level}`} title={tip}>
      <span className="budget-label">~/.cursor</span>
      <div className="bar">
        <div className="fill" style={{ width: `${Math.max(pct, 1.5)}%` }} />
        <div className="tick" style={{ left: `${(budget.alwaysOnWarnTokens / hard) * 100}%` }} />
        <div className="tick block" style={{ left: `${(budget.alwaysOnBlockTokens / hard) * 100}%` }} />
      </div>
      <span className="budget-num">
        {used.toLocaleString("vi-VN")}/{(hard / 1000).toFixed(0)}k
      </span>
      <span className={`chip ${lint.canSync ? "ok" : "block"}`}>{lint.canSync ? "sync OK" : "chặn sync"}</span>
      {problems.length > 0 && <span className="chip warn">{problems.length} cảnh báo</span>}
    </div>
  );
}
