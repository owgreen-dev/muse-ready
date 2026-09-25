import type { RuleResult, Score, Severity, Status, Subscore } from "./types.js";

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, high: 5, medium: 3, low: 1 };
const CREDIT: Record<Exclude<Status, "not-applicable">, number> = { pass: 1, warn: 0.5, fail: 0 };

/** Categories where any `fail` blocks the badge and fails CI. */
export const GATE_CATEGORIES = new Set(["auth", "injection", "network"]);

function weighted(results: RuleResult[]): number | null {
  let total = 0;
  let earned = 0;
  for (const r of results) {
    if (r.status === "not-applicable") continue;
    const w = SEVERITY_WEIGHT[r.severity];
    total += w;
    earned += w * CREDIT[r.status];
  }
  return total === 0 ? null : Math.round((earned / total) * 100);
}

export function grade(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function computeScore(results: RuleResult[]): Score {
  const overall = weighted(results) ?? 0;
  const sub = (s: Subscore) => weighted(results.filter((r) => r.subscores.includes(s)));
  return { overall, grade: grade(overall), directory: sub("directory"), custom: sub("custom") };
}

/**
 * Blocking failures: a fail in auth, injection or network at high or critical severity. A profile or the
 * user's config can lower a rule to medium or low, and then it no longer blocks (e.g. AUTH001 in muse-directory).
 */
export function computeGate(results: RuleResult[]): { passed: boolean; blocking: string[] } {
  const blocking = results
    .filter((r) => r.status === "fail" && GATE_CATEGORIES.has(r.category) && (r.severity === "critical" || r.severity === "high"))
    .map((r) => r.id);
  return { passed: blocking.length === 0, blocking };
}
