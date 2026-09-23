import type { Finding, Rule } from "../core/types.js";
import { operations } from "../core/openapi.js";
import { aggregate } from "./util.js";

function hasHeader(response: any, name: string): boolean {
  const headers = response?.headers;
  return !!headers && Object.keys(headers).some((h) => h.toLowerCase() === name);
}

export const ERR001: Rule = {
  id: "ERR001",
  title: "Rate limits and auth errors are documented",
  category: "errors",
  severity: "high",
  subscores: ["custom"],
  appliesTo: ["openapi"],
  rationale:
    "A clear 429 with Retry-After lets the agent back off. A bare 403 'sends it down a debugging path on your dime' (Parallel). Documented error responses tell Muse what each failure means.",
  run({ input }) {
    const fails: Finding[] = [];
    const warns: Finding[] = [];
    const ops = operations(input.resolved);
    if (ops.length === 0) return { status: "not-applicable", message: "No operations." };

    const globalSecurity = Array.isArray(input.resolved.security) && input.resolved.security.length > 0;
    let with429 = 0;
    const noAuthErrors: string[] = [];
    for (const o of ops) {
      const responses = o.op.responses ?? {};
      const r429 = responses["429"];
      if (r429) {
        with429++;
        if (!hasHeader(r429, "retry-after")) {
          fails.push({ message: `${o.label} documents 429 without a Retry-After header`, pointer: [...o.pointer, "responses", "429"] });
        }
      }
      const secured = Array.isArray(o.op.security) ? o.op.security.length > 0 : globalSecurity;
      if (secured && !responses["401"] && !responses["403"]) noAuthErrors.push(o.label);
    }
    if (with429 === 0) {
      warns.push({ message: "No operation documents a 429 response. Say how rate limiting is signalled, with Retry-After." });
    }
    if (noAuthErrors.length) {
      const shown = noAuthErrors.slice(0, 5).join(", ");
      const more = noAuthErrors.length > 5 ? ` and ${noAuthErrors.length - 5} more` : "";
      warns.push({ message: `Secured operations with no 401/403 documented: ${shown}${more}` });
    }
    return aggregate(fails, warns, {
      pass: "Rate limiting and auth errors are documented.",
      fail: "Rate-limit responses are missing Retry-After.",
      warn: "Error behaviour is under-documented.",
    });
  },
};
