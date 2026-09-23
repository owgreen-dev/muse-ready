import type { Rule } from "../core/types.js";
import { plural } from "./util.js";

export const SPEC001: Rule = {
  id: "SPEC001",
  title: "OpenAPI document is valid",
  category: "spec",
  severity: "high",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi"],
  rationale:
    "Muse builds its REST client from the OpenAPI document. An invalid document means guessed endpoints and failed calls.",
  run({ input }) {
    const v = input.validation;
    if (!v) return { status: "warn", message: "Validation did not run." };
    if (!v.valid) {
      const shown = v.errors.slice(0, 10).map((message) => ({ message }));
      const more = v.errors.length - shown.length;
      if (more > 0) shown.push({ message: `…and ${more} more` });
      return { status: "fail", message: `Schema validation failed with ${plural(v.errors.length, "error")}.`, findings: shown };
    }
    if (v.warnings.length) {
      return {
        status: "warn",
        message: `Valid, with ${plural(v.warnings.length, "warning")}.`,
        findings: v.warnings.slice(0, 10).map((message) => ({ message })),
      };
    }
    return { status: "pass", message: `Valid ${v.specification ?? "OpenAPI"} document.` };
  },
};
