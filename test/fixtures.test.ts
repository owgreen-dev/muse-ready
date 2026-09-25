import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture, result, run } from "./helpers.js";

describe("good fixtures", () => {
  it("reference OpenAPI connector passes every applicable rule", async () => {
    const report = await run("good/tasks-api.openapi.yaml");
    const notPassing = report.results.filter((r) => r.status !== "pass" && r.status !== "not-applicable");
    expect(notPassing.map((r) => `${r.id}: ${r.message}`)).toEqual([]);
    expect(report.score).toEqual({ overall: 100, grade: "A+", directory: 100, custom: 100 });
    expect(report.gate.passed).toBe(true);
  });

  it("reference MCP tool list passes every applicable rule", async () => {
    const config = JSON.parse(readFileSync(fixture("good/notes-mcp.config.json"), "utf8"));
    const report = await run("good/notes-mcp.tools.json", config);
    const notPassing = report.results.filter((r) => r.status !== "pass" && r.status !== "not-applicable");
    expect(notPassing.map((r) => `${r.id}: ${r.message}`)).toEqual([]);
    expect(report.score.overall).toBe(100);
  });
});

// Every rule must catch its seeded failure. [fixture, rule, expected status, text a finding or message must contain]
const cases: [string, string, "fail" | "warn", string][] = [
  ["bad/spec001-invalid.openapi.yaml", "SPEC001", "fail", "version"],
  ["bad/spec002-swagger2.json", "SPEC002", "fail", "Swagger"],
  ["bad/mcp001-malformed.tools.json", "MCP001", "fail", "Duplicate tool name"],
  ["bad/mcp001-malformed.tools.json", "MCP001", "fail", '"search notes"'],
  ["bad/mcp001-malformed.tools.json", "MCP001", "fail", 'Tool "list_notes" needs an inputSchema'],
  ["bad/desc001-undescribed.openapi.yaml", "DESC001", "fail", "GET /a has no summary or description"],
  ["bad/auth001-oauth-only.openapi.yaml", "AUTH001", "fail", "OAuth-only"],
  ["bad/auth001-oauth-only.openapi.yaml", "AUTH002", "fail", "implicit flow is deprecated"],
  ["bad/auth001-oauth-only.openapi.yaml", "AUTH002", "fail", "no refreshUrl"],
  ["bad/scope001-get-deletes.openapi.yaml", "SCOPE001", "fail", '("delete")'],
  ["bad/scope001-get-deletes.openapi.yaml", "SCOPE001", "fail", "takes a request body"],
  ["bad/scope002-disguised-write.openapi.yaml", "SCOPE002", "fail", "PUT /settings changes state"],
  ["bad/scope002-unannotated.tools.json", "SCOPE002", "fail", "destructiveHint: false"],
  ["bad/scope003-no-confirm.openapi.yaml", "SCOPE003", "warn", "POST /payments"],
  ["bad/scope003-no-confirm.openapi.yaml", "SCOPE003", "warn", "DELETE /accounts/{id}"],
  ["bad/idem001-no-key.openapi.yaml", "IDEM001", "warn", "POST /orders"],
  ["bad/inj001-poisoned.tools.json", "INJ001", "fail", "U+200B"],
  ["bad/inj001-poisoned.tools.json", "INJ001", "fail", "fake control tag"],
  ["bad/inj001-poisoned.tools.json", "INJ001", "fail", "references local secrets"],
  ["bad/inj001-poisoned.tools.json", "INJ001", "fail", "hides actions from the user"],
  ["bad/err001-no-retry-after.openapi.yaml", "ERR001", "fail", "without a Retry-After"],
  ["bad/err001-no-retry-after.openapi.yaml", "ERR001", "fail", "no 401/403"],
  ["bad/page001-unbounded.openapi.yaml", "PAGE001", "warn", "GET /events"],
  ["bad/net001-localhost.openapi.yaml", "NET001", "fail", "http://localhost:3000"],
  ["bad/net001-localhost.openapi.yaml", "NET001", "fail", "192.168.1.20"],
  ["bad/meta001-no-listing.openapi.yaml", "META001", "fail", "privacy policy"],
  ["bad/speak001-no-summary.openapi.yaml", "SPEAK001", "warn", "no summary, title or name field"],
];

describe("bad fixtures", () => {
  it.each(cases)("%s trips %s (%s: %s)", async (file, id, status, text) => {
    const r = result(await run(file), id);
    expect(r.status).toBe(status);
    const haystack = [r.message, ...r.findings.map((f) => f.message)].join("\n");
    expect(haystack).toContain(text);
  });

  it("every built-in rule has at least one seeded failure", async () => {
    const { BUILTIN_RULES } = await import("../src/index.js");
    const covered = new Set(cases.map(([, id]) => id));
    // META002 depends on how the spec is fetched (URL tests); live rules are covered in test/probe.test.ts.
    const elsewhere = new Set(["META002", "NET002", "LAT001", "ERR002", "PAGE002", "MCP002", "META003"]); // MCP002: profiles.test.ts; META003: listing.test.ts
    const uncovered = BUILTIN_RULES.map((r) => r.id).filter((id) => !covered.has(id) && !elsewhere.has(id));
    expect(uncovered).toEqual([]);
  });

  it("blocking failures fail the gate and name the rules", async () => {
    const report = await run("bad/inj001-poisoned.tools.json");
    expect(report.gate.passed).toBe(false);
    expect(report.gate.blocking).toContain("INJ001");
  });

  it("findings carry source line numbers", async () => {
    const r = result(await run("bad/net001-localhost.openapi.yaml"), "NET001");
    expect(r.findings.find((f) => f.message.includes("localhost"))?.line).toBe(5);
  });
});

describe("docs", () => {
  it("README documents every rule", async () => {
    const { BUILTIN_RULES } = await import("../src/index.js");
    const readme = readFileSync(fixture("../README.md"), "utf8");
    for (const r of BUILTIN_RULES) expect(readme, r.id).toContain(`### ${r.id}\n\n**${r.title}.** ${r.rationale}`);
  });
});
