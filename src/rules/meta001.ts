import type { Finding, Rule } from "../core/types.js";
import { checkPublicUrl } from "./net001.js";
import { aggregate, plural } from "./util.js";

const MIN_DESCRIPTION = 40;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    "Muse's directory submission form asks for a name, description, website, example prompts, a 512x512 icon, a support email, privacy policy, terms of service and a documentation link (Manufact walkthrough of the form, 22-24 Sep 2026; third-party, not Meta docs). Set missing fields under connector in muse-ready.config.json or info.x-muse.",
  run({ connector: c }) {
    const fails: Finding[] = [];
    const warns: Finding[] = [];
    const where = ["info"];
    const need = (ok: boolean, label: string) => ok || fails.push({ message: `No ${label}`, pointer: where });

    need(!!str(c.name), "connector name (info.title or connector.name)");
    const description = str(c.description);
    need(!!description, "description (info.description or connector.description)");
    if (description && description.length < MIN_DESCRIPTION) warns.push({ message: `Description is only ${description.length} characters`, pointer: where });
    need(!!str(c.websiteUrl), "website (info.contact.url or connector.websiteUrl)");
    const prompts = Array.isArray(c.examplePrompts) ? c.examplePrompts.filter((p) => typeof p === "string" && p.trim()) : [];
    need(prompts.length > 0, "example prompts (connector.examplePrompts)");
    if (prompts.length > 0 && prompts.length < 3) warns.push({ message: `Only ${plural(prompts.length, "example prompt")}; three or more show the range of what it does`, pointer: where });
    need(!!str(c.iconUrl), "icon URL, 512x512 (connector.iconUrl or info.x-logo.url)");
    const email = str(c.supportEmail);
    need(!!email, "support email (info.contact.email or connector.supportEmail)");
    if (email && !EMAIL.test(email)) warns.push({ message: `Support email "${email}" doesn't look like an email address`, pointer: where });
    need(!!str(c.privacyPolicyUrl), "privacy policy URL (connector.privacyPolicyUrl)");
    need(!!str(c.termsUrl), "terms of service URL (info.termsOfService or connector.termsUrl)");
    need(!!str(c.docsUrl), "documentation URL (externalDocs.url or connector.docsUrl)");
    if (!str(c.company)) warns.push({ message: "No company name (connector.company)", pointer: where });

    for (const [label, value] of [
      ["website", c.websiteUrl],
      ["icon URL", c.iconUrl],
      ["privacy policy URL", c.privacyPolicyUrl],
      ["terms URL", c.termsUrl],
      ["documentation URL", c.docsUrl],
    ] as const) {
      const v = str(value);
      const problem = v ? checkPublicUrl(v) : undefined;
      if (problem) warns.push({ message: `${label}: ${problem.message}`, pointer: where });
    }

    const recommended = warns.length ? `, ${warns.length} recommended` : "";
    return aggregate(fails, warns, {
      pass: "Every field the Muse submission form asks for is present.",
      fail: `${plural(fails.length, "required field")} missing${recommended}.`,
      warn: `No required fields missing, ${warns.length} recommended.`,
    });
  },
};
