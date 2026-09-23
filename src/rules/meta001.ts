import type { Finding, Rule } from "../core/types.js";
import { checkPublicUrl } from "./net001.js";
import { aggregate, plural } from "./util.js";

const MIN_DESCRIPTION = 40;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export const META001: Rule = {
  id: "META001",
  title: "Directory listing metadata is complete",
  category: "metadata",
  severity: "high",
  subscores: ["directory"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Directory submissions are reviewed for 'functional, security and legal requirements' (muse.ai/platform). Meta publishes no checklist yet, so this asks for what every app directory requires: name, description, icon, privacy policy and terms.",
  run({ input, connector }) {
    const info = input.kind === "openapi" ? (input.doc?.info ?? {}) : {};
    const fails: Finding[] = [];
    const warns: Finding[] = [];
    const muse = ["info", "x-muse"];

    const name = str(connector.name) ?? str(info.title);
    if (!name) fails.push({ message: "No connector name (info.title or connector.name)", pointer: ["info"] });

    const description = str(connector.description) ?? str(info.description);
    if (!description) fails.push({ message: "No connector description (info.description or connector.description)", pointer: ["info"] });
    else if (description.length < MIN_DESCRIPTION) warns.push({ message: `Description is only ${description.length} characters`, pointer: ["info", "description"] });

    const links: [string, string | undefined, "fail" | "warn"][] = [
      ["privacy policy URL (connector.privacyPolicyUrl)", str(connector.privacyPolicyUrl), "fail"],
      ["terms of service URL (info.termsOfService or connector.termsUrl)", str(connector.termsUrl) ?? str(info.termsOfService), "fail"],
      ["icon URL (connector.iconUrl or info.x-logo.url)", str(connector.iconUrl) ?? str(info["x-logo"]?.url), "warn"],
    ];
    for (const [label, value, level] of links) {
      if (!value) {
        (level === "fail" ? fails : warns).push({ message: `No ${label}`, pointer: muse });
        continue;
      }
      const problem = checkPublicUrl(value);
      if (problem) warns.push({ message: `${label}: ${problem.message}`, pointer: muse });
    }
    if (input.kind === "openapi" && !str(info.contact?.email) && !str(info.contact?.url)) {
      warns.push({ message: "No support contact (info.contact.email or info.contact.url)", pointer: ["info"] });
    }

    const recommended = warns.length ? `, ${warns.length} recommended` : "";
    return aggregate(fails, warns, {
      pass: "Name, description, icon, privacy policy and terms are all present.",
      fail: `${plural(fails.length, "required field")} missing${recommended}.`,
      warn: `No required fields missing, ${warns.length} recommended.`,
    });
  },
};
