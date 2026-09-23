import type { Finding, Rule } from "../core/types.js";
import { SAFE_METHODS, operations } from "../core/openapi.js";
import { DESTRUCTIVE_VERBS, READ_VERBS, aggregate, firstWord } from "./util.js";

export const SCOPE002: Rule = {
  id: "SCOPE002",
  title: "Write operations are clearly marked as writes",
  category: "scope",
  severity: "high",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "The approval dialog shows the user what Muse is about to do. A write named like a read makes that prompt misleading, and unmarked MCP tools give the client nothing to gate on.",
  run({ input }) {
    const fails: Finding[] = [];
    const warns: Finding[] = [];
    let writes = 0;

    if (input.kind === "openapi") {
      for (const o of operations(input.resolved)) {
        if (SAFE_METHODS.has(o.method)) continue;
        writes++;
        const verb = firstWord(o.op.operationId) ?? firstWord(o.op.summary);
        if (!verb || !READ_VERBS.has(verb)) continue;
        if (o.method === "post") {
          warns.push({
            message: `${o.label} is named like a read ("${verb}"). Muse will still treat POST as a write and ask for approval. Use GET if it has no side effects.`,
            pointer: o.pointer,
          });
        } else {
          fails.push({ message: `${o.label} changes state but is named like a read ("${verb}")`, pointer: o.pointer });
        }
      }
    } else {
      const base = Array.isArray(input.doc) ? [] : input.doc?.result ? ["result", "tools"] : ["tools"];
      (input.tools ?? []).forEach((tool, i) => {
        if (!tool || typeof tool !== "object") return;
        const name = String(tool.name);
        const verb = firstWord(tool.name);
        const a = tool.annotations;
        const pointer = [...base, i];
        if (!a || (a.readOnlyHint === undefined && a.destructiveHint === undefined)) {
          warns.push({ message: `Tool "${name}" has no readOnlyHint or destructiveHint annotation`, pointer });
          return;
        }
        if (verb && DESTRUCTIVE_VERBS.has(verb) && a.destructiveHint === false) {
          fails.push({ message: `Tool "${name}" is named like a destructive action but sets destructiveHint: false`, pointer: [...pointer, "annotations"] });
        }      });
      if ((input.tools ?? []).length === 0) return { status: "not-applicable", message: "No tools to check." };
    }

    if (input.kind === "openapi" && writes === 0) return { status: "not-applicable", message: "No write operations found." };
    return aggregate(fails, warns, {
      pass: input.kind === "openapi" ? `${writes} write operation(s), all named as writes.` : "All tools are annotated consistently.",
      fail: `${fails.length} write(s) are disguised as reads or mis-annotated.`,
      warn: `${warns.length} write-marking gap(s).`,
    });
  },
};
