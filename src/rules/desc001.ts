import type { Finding, Rule } from "../core/types.js";
import { operations } from "../core/openapi.js";
import { aggregate, agree, all, plural } from "./util.js";

const MIN_CHARS = 20;

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export const DESC001: Rule = {
  id: "DESC001",
  title: "Every operation or tool is described",
  category: "description",
  severity: "high",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "The agent picks which call to make from names and descriptions alone. Missing or one-word descriptions cause wrong or skipped calls.",
  run({ input }) {
    const fails: Finding[] = [];
    const warns: Finding[] = [];
    let count = 0;

    if (input.kind === "openapi") {
      for (const o of operations(input.resolved)) {
        count++;
        const desc = text(o.op.description) || text(o.op.summary);
        if (!desc) fails.push({ message: `${o.label} has no summary or description`, pointer: o.pointer });
        else if (desc.length < MIN_CHARS) warns.push({ message: `${o.label} description is very short: "${desc}"`, pointer: o.pointer });
        if (!text(o.op.operationId)) warns.push({ message: `${o.label} has no operationId`, pointer: o.pointer });
        const params = [...(o.pathItem.parameters ?? []), ...(o.op.parameters ?? [])];
        const bare = params.filter((p: any) => p && typeof p.name === "string" && !text(p.description)).map((p: any) => p.name);
        if (bare.length) warns.push({ message: `${o.label} parameters without descriptions: ${bare.join(", ")}`, pointer: o.pointer });
      }
      if (count === 0) return { status: "fail", message: "The document defines no operations." };
    } else {
      const tools = input.tools ?? [];
      const base = Array.isArray(input.doc) ? [] : input.doc?.result ? ["result", "tools"] : ["tools"];
      tools.forEach((tool, i) => {
        if (!tool || typeof tool !== "object") return;
        count++;
        const name = String(tool.name);
        const pointer = [...base, i];
        const desc = text(tool.description);
        if (!desc) fails.push({ message: `Tool "${name}" has no description`, pointer });
        else if (desc.length < MIN_CHARS) warns.push({ message: `Tool "${name}" description is very short: "${desc}"`, pointer });
        const props = (tool.inputSchema as any)?.properties;
        if (props && typeof props === "object") {
          const bare = Object.entries<any>(props).filter(([, s]) => !text(s?.description)).map(([k]) => k);
          if (bare.length) warns.push({ message: `Tool "${name}" inputs without descriptions: ${bare.join(", ")}`, pointer: [...pointer, "inputSchema"] });
        }
      });
      if (count === 0) return { status: "not-applicable", message: "No tools to check." };
    }

    return aggregate(fails, warns, {
      pass: `${all(count, input.kind === "openapi" ? "operation" : "tool")} ${agree(count, "is", "are")} described.`,
      fail: `${fails.length} of ${count} ${agree(count, input.kind === "openapi" ? "operation" : "tool", input.kind === "openapi" ? "operations" : "tools")} undescribed.`,
      warn: `${plural(warns.length, "description gap")} across ${plural(count, input.kind === "openapi" ? "operation" : "tool")}.`,
    });
  },
};
