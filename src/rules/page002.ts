import type { Finding, Rule } from "../core/types.js";
import { operations, returnsList, successSchema } from "../core/openapi.js";
import { aggregate, plural } from "./util.js";
import { probeUnavailable } from "./probe-util.js";

// Provisional: Muse's response-size limit is undocumented (base.md, section A "UNKNOWN").
export const WARN_BYTES = 256 * 1024;
export const FAIL_BYTES = 1024 * 1024;

export const PAGE002: Rule = {
  id: "PAGE002",
  title: "Live: list responses are a sensible size",
  category: "performance",
  severity: "medium",
  subscores: ["custom"],
  appliesTo: ["openapi"],
  rationale:
    "Large responses risk truncation and consume the user's weekly token meter. Muse's limit is undocumented; thresholds are provisional: warn above 256 KiB, fail above 1 MiB for a default page. Checked live with --probe.",
  run(ctx) {
    const unavailable = probeUnavailable(ctx);
    if (unavailable) return unavailable;
    const lists = new Set(operations(ctx.input.resolved).filter((o) => o.method === "get" && returnsList(successSchema(o.op))).map((o) => o.label));
    const samples = ctx.probe!.requests.filter((r) => r.operation && lists.has(r.operation) && r.status !== undefined && r.status < 300 && r.bytes !== undefined);
    if (samples.length === 0) {
      return { status: "not-applicable", message: lists.size ? "No list endpoint returned data (it may need credentials: set MUSE_READY_TOKEN)." : "No list endpoints." };
    }
    const fails: Finding[] = [];
    const warns: Finding[] = [];
    const seen = new Set<string>();
    for (const r of samples) {
      if (seen.has(r.operation!)) continue;
      seen.add(r.operation!);
      const kib = Math.round(r.bytes! / 1024);
      if (r.truncated || r.bytes! > FAIL_BYTES) fails.push({ message: `${r.operation} returned more than 1 MiB for a default page` });
      else if (r.bytes! > WARN_BYTES) warns.push({ message: `${r.operation} returned ${kib} KiB for a default page` });
    }
    return aggregate(fails, warns, {
      pass: `${plural(seen.size, "list endpoint")} sampled, all under 256 KiB.`,
      fail: "List responses are too large for an agent.",
      warn: "List responses are large.",
    });
  },
};
