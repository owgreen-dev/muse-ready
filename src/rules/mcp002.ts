import type { Finding, Rule } from "../core/types.js";
import { aggregate, plural } from "./util.js";

export const MCP002: Rule = {
  id: "MCP002",
  title: "MCP tools declare a human-readable title",
  category: "description",
  severity: "medium",
  subscores: ["directory"],
  appliesTo: ["mcp"],
  rationale:
    "Anthropic's Connectors Directory requires a title on every tool, and clients use it to show people what the agent is doing. Off in the Muse profile, which publishes no such requirement.",
  run({ input }) {
    const tools = input.tools ?? [];
    if (tools.length === 0) return { status: "not-applicable", message: "No tools to check." };
    const base = Array.isArray(input.doc) ? [] : input.doc?.result ? ["result", "tools"] : ["tools"];
    const fails: Finding[] = [];
    tools.forEach((tool, i) => {
      const title = tool?.title ?? (tool?.annotations as Record<string, unknown> | undefined)?.title;
      if (typeof title !== "string" || !title.trim()) fails.push({ message: `Tool "${String(tool?.name)}" has no title`, pointer: [...base, i] });
    });
    return aggregate(fails, [], {
      pass: `Every tool has a title.`,
      fail: `${plural(fails.length, "tool")} without a title.`,
      warn: "",
    });
  },
};
