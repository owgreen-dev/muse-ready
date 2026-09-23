import type { Rule } from "../core/types.js";
import { checkPublicUrl } from "./net001.js";

export const META002: Rule = {
  id: "META002",
  title: "Spec is published at a public URL",
  category: "metadata",
  severity: "high",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi"],
  rationale:
    "The clean path for a Muse custom connector is handing it a public, unauthenticated OpenAPI URL (Parallel hands-on test). A spec behind a login wall forces Muse to scrape docs instead.",
  run({ input }) {
    if (!input.isUrl) {
      return {
        status: "not-applicable",
        message: "Checked a local file. Run against the spec's public URL to confirm Muse can fetch it.",
      };
    }
    const problem = checkPublicUrl(input.source);
    if (problem) return { status: problem.level, message: problem.message };
    return { status: "pass", message: "Fetched without credentials over public HTTPS." };
  },
};
