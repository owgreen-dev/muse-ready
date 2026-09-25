import type { Config } from "./config.js";
import { makeLineLocator } from "./lines.js";
import { getProfile } from "./profiles.js";
import { computeGate, computeScore } from "./score.js";
import type { ConnectorMeta, LoadedInput, ProbeResult, Report, Rule, RuleContext, RuleResult } from "./types.js";
import { RULESET_DATE, TOOL_NAME, TOOL_VERSION } from "./version.js";

export function connectorFrom(input: LoadedInput, config: Config): ConnectorMeta {
  // OpenAPI docs may carry Muse metadata under info.x-muse; the config file wins over it.
  const info = input.kind === "openapi" ? (input.doc?.info ?? {}) : {};
  // Standard OpenAPI fields first, then info.x-muse, then the config file.
  const standard = {
    ...(typeof info.title === "string" ? { name: info.title } : {}),
    ...(typeof info.description === "string" ? { description: info.description } : {}),
    ...(typeof info.contact?.url === "string" ? { websiteUrl: info.contact.url } : {}),
    ...(typeof info.contact?.email === "string" ? { supportEmail: info.contact.email } : {}),
    ...(typeof info.termsOfService === "string" ? { termsUrl: info.termsOfService } : {}),
    ...(typeof info["x-logo"]?.url === "string" ? { iconUrl: info["x-logo"].url } : {}),
    ...(input.kind === "openapi" && typeof input.doc?.externalDocs?.url === "string" ? { docsUrl: input.doc.externalDocs.url } : {}),
  };
  return { ...standard, ...(info["x-muse"] ?? {}), ...(config.connector ?? {}) };
}

export async function runRules(input: LoadedInput, rules: Rule[], config: Config = {}, probe?: ProbeResult, simulation?: Report["simulation"]): Promise<Report> {
  const ctx: RuleContext = { input, connector: connectorFrom(input, config), probe };
  const profile = getProfile(config.profile);
  const lineFor = makeLineLocator(input.raw);
  const results: RuleResult[] = [];

  for (const rule of rules) {
    // The user's own config wins over the profile, which wins over the rule's default.
    const setting = config.rules?.[rule.id] ?? profile.rules[rule.id];
    if (setting === "off") continue;
    const severity = setting ?? rule.severity;
    const base = {
      id: rule.id,
      title: rule.title,
      category: rule.category,
      severity,
      subscores: rule.subscores,
      rationale: rule.rationale,
    };
    if (!rule.appliesTo.includes(input.kind)) {
      results.push({ ...base, status: "not-applicable", message: `Does not apply to ${input.kind} input.`, findings: [] });
      continue;
    }
    try {
      const outcome = await rule.run(ctx);
      const findings = (outcome.findings ?? []).map((f) => (f.pointer ? { ...f, line: lineFor(f.pointer) } : f));
      results.push({ ...base, ...outcome, findings });
    } catch (err) {
      results.push({
        ...base,
        status: "warn",
        message: `Rule crashed and was skipped: ${(err as Error).message}`,
        findings: [],
      });
    }
  }

  const info = input.kind === "openapi" ? input.doc?.info : undefined;
  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION, rulesetDate: RULESET_DATE },
    profile: { id: profile.id, title: profile.title },
    generatedAt: new Date().toISOString(),
    input: {
      source: input.source,
      kind: input.kind,
      title: typeof info?.title === "string" ? info.title : undefined,
      version: typeof info?.version === "string" ? info.version : undefined,
    },
    score: computeScore(results),
    gate: computeGate(results),
    ...(probe
      ? {
          probe: {
            enabled: true as const,
            target: probe.target,
            requests: probe.requests.map(({ bodySample: _omit, ...r }) => r),
            skipped: probe.skipped,
            ...(probe.mcp ? { mcp: probe.mcp } : {}),
            ...(probe.error ? { error: probe.error } : {}),
          },
        }
      : {}),
    ...(simulation ? { simulation } : {}),
    results,
  };
}
