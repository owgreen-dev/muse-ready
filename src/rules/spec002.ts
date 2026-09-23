import type { Rule } from "../core/types.js";

export const SPEC002: Rule = {
  id: "SPEC002",
  title: "Uses OpenAPI 3.1",
  category: "spec",
  severity: "medium",
  subscores: ["custom"],
  appliesTo: ["openapi"],
  rationale:
    "Meta names no OpenAPI version. 3.1 has the widest current tool support and aligns with JSON Schema, so it is the safest target (inference, not a Meta rule).",
  run({ input }) {
    const doc = input.doc;
    if (typeof doc.swagger === "string") {
      return {
        status: "fail",
        message: `Swagger ${doc.swagger} is legacy. Convert to OpenAPI 3.1.`,
        findings: [{ message: "Swagger 2.0 document", pointer: ["swagger"] }],
      };
    }
    const version = String(doc.openapi);
    if (/^3\.[1-9]/.test(version)) return { status: "pass", message: `OpenAPI ${version}.` };
    return {
      status: "warn",
      message: `OpenAPI ${version}. Prefer 3.1.`,
      findings: [{ message: `openapi: ${version}`, pointer: ["openapi"] }],
    };
  },
};
