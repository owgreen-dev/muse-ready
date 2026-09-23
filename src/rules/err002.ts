import type { Finding, Rule } from "../core/types.js";
import { isSecured, operations } from "../core/openapi.js";
import { aggregate, plural } from "./util.js";
import { probeUnavailable } from "./probe-util.js";

/** Signs that an error body leaks internals. */
export const LEAK_PATTERNS: [RegExp, string][] = [
  [/^\s*at\s+\S+\s+\(?[^)\n]*:\d+:\d+\)?/m, "a JavaScript stack trace"],
  [/Traceback \(most recent call last\)/, "a Python traceback"],
  [/\bat\s+[\w$.]+\([\w$]+\.java:\d+\)/, "a Java stack trace"],
  [/(SQLSTATE\[|ORA-\d{5}|syntax error at or near|PG::\w+Error|mysql_fetch)/i, "a database error"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{16,}|ghp_[0-9A-Za-z]{30,}|xox[bpa]-[0-9A-Za-z-]{10,})\b/, "a credential"],
];

export const ERR002: Rule = {
  id: "ERR002",
  title: "Live: unauthenticated calls are rejected cleanly",
  category: "errors",
  severity: "high",
  subscores: ["custom"],
  appliesTo: ["openapi"],
  rationale:
    "A secured endpoint that answers without credentials is an auth hole, and error bodies with stack traces or secrets leak internals into the agent's context (OWASP LLM02). A clear 401/403 tells Muse to ask the user for a credential. Checked live with --probe.",
  run(ctx) {
    const unavailable = probeUnavailable(ctx);
    if (unavailable) return unavailable;
    const secured = new Set(operations(ctx.input.resolved).filter((o) => isSecured(ctx.input.resolved, o.op)).map((o) => o.label));
    const fails: Finding[] = [];
    const warns: Finding[] = [];
    let checked = 0;

    for (const r of ctx.probe!.requests) {
      if (r.status === undefined) continue;
      const label = `${r.method} ${r.path}`;
      for (const [re, what] of LEAK_PATTERNS) if (r.bodySample && re.test(r.bodySample)) fails.push({ message: `${label} (HTTP ${r.status}) returned ${what}` });
      if (r.status >= 500) fails.push({ message: `${label} returned HTTP ${r.status}` });
      if (r.authenticated || !r.operation || !secured.has(r.operation) || r.status >= 500) continue;
      checked++;
      if (r.status >= 200 && r.status < 300) fails.push({ message: `${label} is documented as secured but answered HTTP ${r.status} without credentials` });
      else if (r.status !== 401 && r.status !== 403) warns.push({ message: `${label} answered HTTP ${r.status} without credentials; expected 401 or 403` });
      else if (!r.bodySample?.trim()) warns.push({ message: `${label} returned ${r.status} with an empty body; say what credential is missing` });
    }
    if (checked === 0 && fails.length === 0) {
      return { status: "not-applicable", message: secured.size ? "No secured operation could be called safely." : "No operations are documented as secured." };
    }
    // Latency samples repeat requests; report each problem once.
    const unique = (list: Finding[]) => [...new Map(list.map((f) => [f.message, f])).values()];
    return aggregate(unique(fails), unique(warns), {
      pass: `${plural(checked, "secured operation")} rejected unauthenticated calls with a clear 401/403.`,
      fail: "Error responses leak internals or skip authentication.",
      warn: "Unauthenticated calls are not rejected clearly.",
    });
  },
};
