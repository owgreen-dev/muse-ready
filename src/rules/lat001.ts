import type { Rule } from "../core/types.js";
import { plural } from "./util.js";
import { answered, probeUnavailable } from "./probe-util.js";

// Provisional: Muse's per-call timeout is undocumented (base.md, section A "UNKNOWN").
export const WARN_MS = 3_000;
export const FAIL_MS = 30_000;

export function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

export const LAT001: Rule = {
  id: "LAT001",
  title: "Live: responds quickly",
  category: "performance",
  severity: "medium",
  subscores: ["custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Muse's timeout is undocumented, and slow calls burn the user's weekly token meter while the agent waits. Thresholds are provisional: warn above 3 s p95, fail above 30 s or on timeout. Checked live with --probe.",
  run(ctx) {
    const unavailable = probeUnavailable(ctx);
    if (unavailable) return unavailable;
    const probe = ctx.probe!;
    const timeouts = probe.requests.filter((r) => r.error?.code === "timeout");
    if (timeouts.length) {
      return { status: "fail", message: `${plural(timeouts.length, "request")} timed out.`, findings: timeouts.map((r) => ({ message: `${r.method} ${r.path}: ${r.error!.message}` })) };
    }
    const times = answered(probe).map((r) => r.ms!).filter((ms) => ms !== undefined);
    if (times.length === 0) return { status: "not-applicable", message: "No request completed, so latency could not be measured." };
    const worst = p95(times);
    const summary = `p95 ${worst} ms over ${plural(times.length, "request")}.`;
    if (worst > FAIL_MS) return { status: "fail", message: `${summary} Muse is likely to give up.` };
    if (worst > WARN_MS) return { status: "warn", message: `${summary} Slower than ${WARN_MS / 1000} s.` };
    return { status: "pass", message: summary };
  },
};
