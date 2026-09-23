import type { Finding, Rule } from "../core/types.js";
import { SAFE_METHODS, inputNames, operations } from "../core/openapi.js";
import { CONFIRM_PARAM, HIGH_IMPACT_VERBS, aggregate, firstWord } from "./util.js";

export const SCOPE003: Rule = {
  id: "SCOPE003",
  title: "High-impact actions take a confirm or dry-run parameter",
  category: "scope",
  severity: "medium",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Deleting, paying, sending and publishing are the actions Muse's approval model exists for. A confirm or dry-run parameter gives the agent a safe first call to show the user before committing.",
  run({ input }) {
    const warns: Finding[] = [];
    let risky = 0;

    if (input.kind === "openapi") {
      for (const o of operations(input.resolved)) {
        if (SAFE_METHODS.has(o.method)) continue;
        const verb = firstWord(o.op.operationId) ?? firstWord(o.op.summary);
        const highImpact = o.method === "delete" || (verb !== undefined && HIGH_IMPACT_VERBS.has(verb));
        if (!highImpact) continue;
        risky++;
        if (!inputNames(o).some((n) => CONFIRM_PARAM.test(n))) {
          warns.push({ message: `${o.label} is high-impact and has no confirm or dry_run parameter`, pointer: o.pointer });
        }
      }
    } else {
      const base = Array.isArray(input.doc) ? [] : input.doc?.result ? ["result", "tools"] : ["tools"];
      (input.tools ?? []).forEach((tool, i) => {
        const verb = firstWord(tool?.name);
        if (!verb || !HIGH_IMPACT_VERBS.has(verb)) return;
        risky++;
        const props = Object.keys((tool.inputSchema as any)?.properties ?? {});
        if (!props.some((n) => CONFIRM_PARAM.test(n))) {
          warns.push({ message: `Tool "${String(tool.name)}" is high-impact and has no confirm or dry_run input`, pointer: [...base, i] });
        }
      });
    }

    if (risky === 0) return { status: "not-applicable", message: "No high-impact actions found." };
    return aggregate([], warns, {
      pass: `All ${risky} high-impact action(s) take a confirm or dry-run parameter.`,
      fail: "",
      warn: `${warns.length} of ${risky} high-impact action(s) commit immediately.`,
    });
  },
};
