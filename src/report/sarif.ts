import { relative } from "node:path";
import type { Report, Severity } from "../core/types.js";
import { BUILTIN_RULES } from "../rules/index.js";

const REPO_URL = "https://github.com/owgreen-dev/muse-ready";

const SECURITY_SEVERITY: Record<Severity, string> = { critical: "9.0", high: "7.0", medium: "5.0", low: "3.0" };

export function renderSarif(report: Report, cwd = process.cwd()): object {
  const uri = report.input.source.match(/^https?:\/\//)
    ? report.input.source
    : relative(cwd, report.input.source).split("\\").join("/");
  const ruleIndex = new Map(BUILTIN_RULES.map((r, i) => [r.id, i]));

  const results = report.results
    .filter((r) => r.status === "fail" || r.status === "warn")
    .flatMap((r) => {
      const level = r.status === "fail" ? "error" : "warning";
      const findings = r.findings.length ? r.findings : [{ message: r.message }];
      return findings.map((f) => ({
        ruleId: r.id,
        ruleIndex: ruleIndex.get(r.id),
        level,
        message: { text: f.message === r.message ? r.message : `${r.message} ${f.message}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri },
              region: { startLine: ("line" in f && f.line) || 1 },
            },
          },
        ],
      }));
    });

  if (report.simulation) {
    const sim = report.simulation;
    const simUri = relative(cwd, sim.tasksFile).split("\\").join("/");
    for (const s of sim.scenarios) {
      const fail = s.runs.find((r) => !r.pass);
      if (!fail) continue;
      results.push({
        ruleId: "SIM001",
        ruleIndex: BUILTIN_RULES.length,
        level: s.passed === 0 ? "error" : "warning",
        message: { text: `Scenario "${s.id}" passed ${s.passed}/${s.runs.length} runs: ${fail.reasons.join("; ")}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: simUri }, region: { startLine: s.line ?? 1 } } }],
      });
    }
  }

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: report.tool.name,
            version: report.tool.version,
            informationUri: REPO_URL,
            rules: BUILTIN_RULES.map((r) => ({
              id: r.id,
              name: r.title.replace(/[^A-Za-z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : "")),
              shortDescription: { text: r.title },
              fullDescription: { text: r.rationale },
              helpUri: `${REPO_URL}#${r.id.toLowerCase()}`,
              defaultConfiguration: { level: r.severity === "critical" || r.severity === "high" ? "error" : "warning" },
              properties: {
                tags: [r.category, "muse"],
                ...(["auth", "injection", "network"].includes(r.category) ? { "security-severity": SECURITY_SEVERITY[r.severity] } : {}),
              },
            })).concat([
              {
                id: "SIM001",
                name: "ScenarioPasses",
                shortDescription: { text: "Simulated agent completes the scenario" },
                fullDescription: { text: "A model acting as the agent made the calls the scenario expects, with the right arguments and no unexpected writes. Tool calls are answered from the spec's examples." },
                helpUri: `${REPO_URL}#simulation`,
                defaultConfiguration: { level: "warning" },
                properties: { tags: ["simulation"] },
              } as any,
            ]),
          },
        },
        results,
      },
    ],
  };
}
