import pc from "picocolors";
import { getProfile } from "../core/profiles.js";
import type { Report, RuleResult, Status } from "../core/types.js";

const ICON: Record<Status, string> = { pass: "✔", warn: "▲", fail: "✖", "not-applicable": "–" };
const MAX_FINDINGS = 5;

export function renderTerminal(report: Report, opts: { color?: boolean; verbose?: boolean } = {}): string {
  const c = pc.createColors(opts.color ?? pc.isColorSupported);
  const paint: Record<Status, (s: string) => string> = { pass: c.green, warn: c.yellow, fail: c.red, "not-applicable": c.dim };
  const lines: string[] = [];
  const { input, score, gate } = report;

  lines.push(c.bold(`muse-ready ${report.tool.version}`) + c.dim(`  ruleset ${report.tool.rulesetDate}  profile ${report.profile.id}`));
  lines.push(
    input.title
      ? `${input.title}${input.version ? ` v${input.version}` : ""} ${c.dim(`(${input.kind}, ${input.source})`)}`
      : `${input.source} ${c.dim(`(${input.kind})`)}`,
  );
  lines.push("");

  const shown = opts.verbose ? report.results : report.results.filter((r) => r.status !== "not-applicable");
  const idWidth = Math.max(...shown.map((r) => r.id.length), 2);
  for (const r of shown) {
    lines.push(`${paint[r.status](ICON[r.status])} ${c.bold(r.id.padEnd(idWidth))}  ${r.title} ${c.dim(`[${r.severity}]`)}`);
    lines.push(`  ${" ".repeat(idWidth)}  ${paint[r.status](r.message)}`);
    for (const f of findingsFor(r)) lines.push(c.dim(`  ${" ".repeat(idWidth)}    · ${f}`));
  }
  const skipped = report.results.length - shown.length;
  if (skipped) lines.push(c.dim(`${skipped} ${skipped === 1 ? "rule does" : "rules do"} not apply to this input (use --verbose to list).`));

  if (report.simulation) {
    const sim = report.simulation;
    lines.push("");
    lines.push(`${c.bold("Simulation")} ${c.dim(`${sim.model}, ${sim.runs} ${sim.runs === 1 ? "run" : "runs"} per scenario`)}`);
    for (const s of sim.scenarios) {
      const total = s.runs.length;
      const status: Status = s.passed === total ? "pass" : s.passed === 0 ? "fail" : "warn";
      lines.push(`${paint[status](ICON[status])} ${s.id.padEnd(idWidth)}  ${s.passed}/${total}  ${c.dim(`"${s.request}"`)}`);
      const firstFail = s.runs.find((r) => !r.pass);
      if (firstFail) for (const reason of firstFail.reasons.slice(0, 3)) lines.push(c.dim(`  ${" ".repeat(idWidth)}    · ${reason}`));
    }
    lines.push(`${c.bold("Scenario pass rate")} ${sim.passRate}%`);
  }
  if (report.probe) {
    const answered = report.probe.requests.filter((r) => r.status !== undefined).length;
    const authed = report.probe.requests.filter((r) => r.authenticated).length;
    lines.push(c.dim(`Probe: ${report.probe.requests.length} GET ${report.probe.requests.length === 1 ? "request" : "requests"} to ${report.probe.target || "(no target)"}, ${answered} answered${authed ? `, ${authed} authenticated` : ""}.`));
  }

  lines.push("");
  const gradeColor = score.overall >= 80 ? c.green : score.overall >= 60 ? c.yellow : c.red;
  const sub = [
    score.directory !== null ? `directory ${score.directory}` : undefined,
    score.custom !== null ? `custom connector ${score.custom}` : undefined,
  ].filter(Boolean);
  lines.push(`${c.bold("Readiness")} ${gradeColor(c.bold(`${score.overall}/100 ${score.grade}`))}  ${c.dim(sub.join(" · "))}`);
  lines.push(
    gate.passed
      ? c.green("No blocking failures in auth, injection or network.")
      : c.red(`Blocked by ${gate.blocking.join(", ")}. Fix these before ${getProfile(report.profile.id).goal}.`),
  );
  return lines.join("\n");
}

function findingsFor(r: RuleResult): string[] {
  if (r.status === "pass" || r.status === "not-applicable") return [];
  const out = r.findings.slice(0, MAX_FINDINGS).map((f) => (f.line ? `${f.message} (line ${f.line})` : f.message));
  if (r.findings.length > MAX_FINDINGS) out.push(`…and ${r.findings.length - MAX_FINDINGS} more`);
  return out;
}
