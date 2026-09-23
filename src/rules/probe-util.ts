import type { ProbeResult, RuleContext, RuleOutcome } from "../core/types.js";

/** Common not-applicable outcomes for live rules. Returns undefined when the probe has data to judge. */
export function probeUnavailable(ctx: RuleContext): RuleOutcome | undefined {
  if (!ctx.probe) return { status: "not-applicable", message: "Live check. Run with --probe to include it." };
  if (ctx.probe.error) return { status: "not-applicable", message: `Probe could not run: ${ctx.probe.error}` };
  return undefined;
}

export function answered(probe: ProbeResult) {
  return probe.requests.filter((r) => r.status !== undefined);
}
