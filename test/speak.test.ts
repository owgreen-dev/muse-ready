import { describe, expect, it } from "vitest";
import { BUILTIN_RULES, loadInput, runRules } from "../src/index.js";
import { speakableValue } from "../src/rules/speak001.js";
import { fixture, result } from "./helpers.js";

describe("SPEAK001", () => {
  it("finds a short readable field in objects, lists and wrapped lists", () => {
    expect(speakableValue({ id: "1", title: "Buy milk" })).toBe("Buy milk");
    expect(speakableValue([{ id: "1", name: "Ada" }])).toBe("Ada");
    expect(speakableValue({ items: [{ id: "1", summary: "Order shipped" }] })).toBe("Order shipped");
    expect(speakableValue({ id: "1", amount_cents: 500 })).toBeNull();
    expect(speakableValue({ id: "1", description: "x".repeat(500) })).toBeNull();
  });

  it("passes live responses with a speakable field and warns on ones without", async () => {
    const input = await loadInput(fixture("bad/speak001-no-summary.openapi.yaml"));
    const probe = (bodySample: string) => ({
      enabled: true as const, target: "https://api.example.com", skipped: [],
      requests: [{ method: "GET", path: "/orders", operation: "GET /orders", status: 200, ms: 10, bodySample }],
    });
    const ids = await runRules(input, BUILTIN_RULES, {}, probe('[{"id":"o_1","amount_cents":500}]'));
    const r = result(ids, "SPEAK001");
    expect(r.status).toBe("warn");
    expect(r.findings.map((f) => f.message).join("\n")).toContain("(live)");
  });
});
