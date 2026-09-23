import type { Finding, Rule } from "../core/types.js";
import { operations, returnsList, successSchema } from "../core/openapi.js";
import { aggregate, agree, all, plural } from "./util.js";

const PAGING = /^(limit|per_?page|page_?size|max_?results|max|top|first|count|size|cursor|page|offset|skip|page_?token|next_?token|next|after|before|starting_after|ending_before|since_id|continuation_?token)$/i;
export const PAGE001: Rule = {
  id: "PAGE001",
  title: "List endpoints are paginated",
  category: "errors",
  severity: "medium",
  subscores: ["custom"],
  appliesTo: ["openapi"],
  rationale:
    "Muse's response-size and timeout limits are undocumented. Unbounded lists risk truncation and burn the user's weekly token meter. Pagination parameters let the agent ask for less.",
  run({ input }) {
    const warns: Finding[] = [];
    let lists = 0;
    for (const o of operations(input.resolved)) {
      if (o.method !== "get" || !returnsList(successSchema(o.op))) continue;
      lists++;
      const params = [...(o.pathItem.parameters ?? []), ...(o.op.parameters ?? [])];
      if (!params.some((p: any) => typeof p?.name === "string" && PAGING.test(p.name))) {
        warns.push({ message: `${o.label} returns a list with no limit, page or cursor parameter`, pointer: o.pointer });
      }
    }
    if (lists === 0) return { status: "not-applicable", message: "No list endpoints detected." };
    return aggregate([], warns, {
      pass: `${all(lists, "list endpoint")} ${agree(lists, "is", "are")} paginated.`,
      fail: "",
      warn: `${warns.length} of ${plural(lists, "list endpoint")} ${agree(warns.length, "returns", "return")} everything at once.`,
    });
  },
};
