import type { Finding, Rule } from "../core/types.js";
import { aggregate, agree, all, plural } from "./util.js";

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export const MCP001: Rule = {
  id: "MCP001",
  title: "MCP tool definitions are well-formed",
  category: "spec",
  severity: "high",
  subscores: ["directory", "custom"],
  appliesTo: ["mcp"],
  rationale:
    "The MCP spec requires each tool to have a unique name and an object inputSchema. Clients reject or mis-route malformed tools.",
  run({ input }) {
    const tools = input.tools ?? [];
    const base = Array.isArray(input.doc) ? [] : input.doc?.result ? ["result", "tools"] : ["tools"];
    if (tools.length === 0) return { status: "fail", message: "The tool list is empty." };
    const fails: Finding[] = [];
    const seen = new Map<string, number>();
    tools.forEach((tool, i) => {
      const pointer = [...base, i];
      if (!tool || typeof tool !== "object") {
        fails.push({ message: `Tool #${i} is not an object`, pointer });
        return;
      }
      if (typeof tool.name !== "string" || !NAME.test(tool.name)) {
        fails.push({
          message: `Tool #${i} name ${JSON.stringify(tool.name)} must be 1–128 characters of A–Z, a–z, 0–9, _ . -`,
          pointer: [...pointer, "name"],
        });
      } else if (seen.has(tool.name)) {
        fails.push({ message: `Duplicate tool name "${tool.name}" (also tool #${seen.get(tool.name)})`, pointer: [...pointer, "name"] });
      } else {
        seen.set(tool.name, i);
      }
      const schema = tool.inputSchema as any;
      if (!schema || typeof schema !== "object" || schema.type !== "object") {
        fails.push({
          message: `Tool "${String(tool.name)}" needs an inputSchema with type "object"`,
          pointer: [...pointer, "inputSchema"],
        });
      }
    });
    return aggregate(fails, [], {
      pass: `${all(tools.length, "tool")} ${agree(tools.length, "is", "are")} well-formed.`,
      fail: `${plural(fails.length, "problem")} across ${plural(tools.length, "tool")}.`,
      warn: "",
    });
  },
};
