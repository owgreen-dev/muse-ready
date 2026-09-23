import type { Report } from "../core/types.js";

/** shields.io endpoint JSON: https://shields.io/badges/endpoint-badge */
export function renderBadge(report: Report): object {
  const { score, gate } = report;
  if (!gate.passed) {
    return { schemaVersion: 1, label: "muse-ready", message: `blocked (${gate.blocking.join(", ")})`, color: "red" };
  }
  const color = score.overall >= 90 ? "brightgreen" : score.overall >= 80 ? "green" : score.overall >= 70 ? "yellowgreen" : score.overall >= 60 ? "yellow" : "orange";
  return { schemaVersion: 1, label: "muse-ready", message: `${score.overall}/100 ${score.grade}`, color };
}
