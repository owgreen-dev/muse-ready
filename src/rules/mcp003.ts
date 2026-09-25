import type { Finding, Rule } from "../core/types.js";
import { aggregate, plural } from "./util.js";

export const MCP003: Rule = {
  id: "MCP003",
  title: "MCP tools declare an output schema",
  category: "description",
  severity: "low",
  subscores: ["custom"],
  appliesTo: ["mcp"],
  rationale:
    "The MCP spec lets tools declare an outputSchema and return matching structuredContent, so agents can rely on result fields instead of parsing text. Recommended, not required; off in the Muse profiles, which publish no such requirement.",
  run({ input }) {
    const tools = (input.tools ?? []).filter((t) => t && typeof t === "object");
    if (tools.length === 0) return { status: "not-applicable", message: "No tools to check." };
    const base = Array.isArray(input.doc) ? [] : input.doc?.result ? ["result", "tools"] : ["tools"];
    const warns: Finding[] = [];
    (input.tools ?? []).forEach((t, i) => {
      const schema = (t as Record<string, any>)?.outputSchema;
      if (!schema || typeof schema !== "object" || schema.type !== "object") warns.push({ message: `Tool "${String(t?.name)}" has no object outputSchema`, pointer: [...base, i] });
    });
    return aggregate([], warns, {
      pass: `Every tool declares an output schema.`,
      fail: "",
      warn: `${plural(warns.length, "tool")} without an output schema.`,
    });
  },
};
