import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  check, computeScore, detectKind, grade, renderBadge, renderMarkdown, renderSarif, validateConfig,
  type RuleResult,
} from "../src/index.js";
import { makeLineLocator } from "../src/core/lines.js";
import { isPrivateHost } from "../src/rules/net001.js";
import { fixture, result, run } from "./helpers.js";

const r = (status: RuleResult["status"], severity: RuleResult["severity"], subscores: RuleResult["subscores"] = ["custom"]): RuleResult => ({
  id: "X", title: "x", category: "spec", severity, subscores, rationale: "", status, message: "", findings: [],
});

describe("scoring", () => {
  it("weights by severity, gives half credit for warnings and ignores not-applicable", () => {
    const s = computeScore([r("pass", "critical"), r("warn", "high"), r("fail", "medium"), r("not-applicable", "critical")]);
    // earned 10 + 2.5 + 0 of 10 + 5 + 3
    expect(s.overall).toBe(Math.round((12.5 / 18) * 100));
    expect(s.directory).toBeNull();
  });

  it("maps scores to grades", () => {
    expect([100, 97, 96, 90, 85, 75, 65, 10].map(grade)).toEqual(["A+", "A+", "A", "A", "B", "C", "D", "F"]);
  });
});

describe("config", () => {
  it("can turn a rule off or change its severity", async () => {
    const off = await run("bad/idem001-no-key.openapi.yaml", { rules: { IDEM001: "off", SPEC002: "low" } });
    expect(off.results.some((x) => x.id === "IDEM001")).toBe(false);
    expect(result(off, "SPEC002").severity).toBe("low");
  });

  it("rejects unknown rule settings", () => {
    expect(() => validateConfig({ rules: { AUTH001: "warn" } }, "cfg")).toThrow(/must be one of/);
  });

  it("lets connector.auth mark a public API as intentionally unauthenticated", async () => {
    const before = await run("bad/meta001-no-listing.openapi.yaml");
    expect(result(before, "AUTH001").status).toBe("warn");
    const after = await run("bad/meta001-no-listing.openapi.yaml", { connector: { auth: "none" } });
    expect(result(after, "AUTH001").status).toBe("pass");
  });
});

describe("auth", () => {
  it("does not block on deprecated OAuth flows when a static credential is also offered", async () => {
    const { loadInput, runRules, BUILTIN_RULES } = await import("../src/index.js");
    const input = await loadInput(fixture("bad/auth001-oauth-only.openapi.yaml"));
    input.resolved.components.securitySchemes.key = { type: "apiKey", in: "header", name: "X-API-Key" };
    const report = await runRules(input, BUILTIN_RULES, {});
    expect(result(report, "AUTH001").status).toBe("pass");
    expect(result(report, "AUTH002").status).toBe("warn");
    expect(report.gate.passed).toBe(true);
  });
});

describe("input handling", () => {
  it("detects OpenAPI, Swagger, tools/list results, JSON-RPC wrappers and bare arrays", () => {
    expect(detectKind({ openapi: "3.1.0" })).toBe("openapi");
    expect(detectKind({ swagger: "2.0" })).toBe("openapi");
    expect(detectKind({ tools: [] })).toBe("mcp");
    expect(detectKind({ result: { tools: [] } })).toBe("mcp");
    expect(detectKind([{ name: "x" }])).toBe("mcp");
    expect(detectKind({ hello: 1 })).toBeUndefined();
  });

  it("rejects files that are neither", async () => {
    await expect(check(fixture("good/notes-mcp.config.json"), { config: {} })).rejects.toThrow(/neither an OpenAPI/);
  });

  it("maps JSON pointers to lines and falls back to the nearest ancestor", () => {
    const lineFor = makeLineLocator("a:\n  b:\n    c: 1\n");
    expect(lineFor(["a", "b", "c"])).toBe(3);
    expect(lineFor(["a", "b", "missing"])).toBe(3);
    expect(makeLineLocator('{"a":{"b":1}}')(["a", "b"])).toBeUndefined();
  });

  it("flags private and local hosts", () => {
    for (const h of ["localhost", "api.localhost", "10.1.2.3", "172.20.0.1", "192.168.0.5", "127.0.0.1", "169.254.169.254", "[::1]", "printer.local", "db.internal"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["api.example.com", "8.8.8.8", "172.32.0.1"]) expect(isPrivateHost(h), h).toBe(false);
  });

  it("fetches specs over HTTP and flags a non-public spec URL", async () => {
    const body = readFileSync(fixture("good/tasks-api.openapi.yaml"), "utf8");
    const server = createServer((_, res) => res.writeHead(200, { "content-type": "application/yaml" }).end(body));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openapi.yaml`;
    try {
      const report = await check(url, { config: {} });
      expect(result(report, "META002").status).toBe("fail");
      expect(result(report, "NET001").status).toBe("pass");
      expect(result(report, "SPEC001").status).toBe("pass");
    } finally {
      server.close();
    }
  });
});

describe("report formats", () => {
  it("SARIF has one result per finding with rule metadata and a line", async () => {
    const report = await run("bad/net001-localhost.openapi.yaml");
    const sarif = renderSarif(report) as any;
    const run0 = sarif.runs[0];
    expect(sarif.version).toBe("2.1.0");
    expect(run0.tool.driver.rules.map((x: any) => x.id)).toContain("NET001");
    const net = run0.results.filter((x: any) => x.ruleId === "NET001");
    expect(net).toHaveLength(2);
    expect(net[0].level).toBe("error");
    expect(net[0].locations[0].physicalLocation.region.startLine).toBe(5);
    expect(run0.tool.driver.rules[net[0].ruleIndex].id).toBe("NET001");
  });

  it("badge reports the score, or blocked when the gate fails", async () => {
    expect(renderBadge(await run("good/tasks-api.openapi.yaml"))).toMatchObject({ message: "100/100 A+", color: "brightgreen" });
    expect(renderBadge(await run("bad/net001-localhost.openapi.yaml"))).toMatchObject({ message: "blocked (NET001)", color: "red" });
  });

  it("Markdown lists findings and escapes table pipes", async () => {
    const md = renderMarkdown(await run("bad/scope003-no-confirm.openapi.yaml"));
    expect(md).toContain("# Muse readiness: Money API");
    expect(md).toContain("## Findings");
    expect(md).toContain("POST /payments");
  });
});
