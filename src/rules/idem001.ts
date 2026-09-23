import type { Finding, Rule } from "../core/types.js";
import { operations } from "../core/openapi.js";
import { aggregate, agree, all, plural } from "./util.js";

const KEY = /^idempotency[-_]?key$/i;

export const IDEM001: Rule = {
  id: "IDEM001",
  title: "Create operations accept an idempotency key",
  category: "scope",
  severity: "medium",
  subscores: ["custom"],
  appliesTo: ["openapi"],
  rationale:
    "Agents retry after timeouts and ambiguous errors. Without an idempotency key, a retried POST can create duplicates or charge twice.",
  run({ input }) {
    const warns: Finding[] = [];
    let posts = 0;
    for (const o of operations(input.resolved)) {
      if (o.method !== "post") continue;
      posts++;
      const params = [...(o.pathItem.parameters ?? []), ...(o.op.parameters ?? [])];
      const ok = params.some((p: any) => typeof p?.name === "string" && KEY.test(p.name));
      if (!ok) warns.push({ message: `${o.label} has no Idempotency-Key header`, pointer: o.pointer });
    }
    if (posts === 0) return { status: "not-applicable", message: "No POST operations." };
    return aggregate([], warns, {
      pass: `${all(posts, "POST operation")} ${agree(posts, "accepts", "accept")} an Idempotency-Key.`,
      fail: "",
      warn: `${warns.length} of ${plural(posts, "POST operation")} ${agree(warns.length, "is", "are")} unsafe to retry.`,
    });
  },
};
