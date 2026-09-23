import type { Finding, Rule } from "../core/types.js";
import { SAFE_METHODS, hasRequestBody, operations } from "../core/openapi.js";
import { WRITE_VERBS, aggregate, firstWord } from "./util.js";

export const SCOPE001: Rule = {
  id: "SCOPE001",
  title: "Read operations have no side effects",
  category: "scope",
  severity: "high",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Muse auto-allows reads and gates writes behind an approval dialog enforced outside the model. A write disguised as a read skips that approval (OWASP LLM06, Excessive Agency).",
  run({ input }) {
    const fails: Finding[] = [];
    let reads = 0;

    if (input.kind === "openapi") {
      for (const o of operations(input.resolved)) {
        if (!SAFE_METHODS.has(o.method)) continue;
        reads++;
        const verb = firstWord(o.op.operationId) ?? firstWord(o.op.summary);
        if (verb && WRITE_VERBS.has(verb)) {
          fails.push({ message: `${o.label} is a read method but is named like a write ("${verb}")`, pointer: o.pointer });
        }
        if (hasRequestBody(o)) {
          fails.push({ message: `${o.label} takes a request body, which suggests it changes state`, pointer: o.pointer });
        }
      }
    } else {
      const base = Array.isArray(input.doc) ? [] : input.doc?.result ? ["result", "tools"] : ["tools"];
      (input.tools ?? []).forEach((tool, i) => {
        if (tool?.annotations?.readOnlyHint !== true) return;
        reads++;
        const verb = firstWord(tool.name);
        if (verb && WRITE_VERBS.has(verb)) {
          fails.push({
            message: `Tool "${String(tool.name)}" is marked readOnlyHint but is named like a write ("${verb}")`,
            pointer: [...base, i, "annotations"],
          });
        }
      });
    }

    if (reads === 0) return { status: "not-applicable", message: "No read operations found." };
    return aggregate(fails, [], {
      pass: `${reads} read operation(s), none look like writes.`,
      fail: `${fails.length} read operation(s) look like they change state.`,
      warn: "",
    });
  },
};
