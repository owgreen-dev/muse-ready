import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_RULES, PROFILES, check, getProfile } from "../src/index.js";
import { fixture, run } from "./helpers.js";

const ids = (report: Awaited<ReturnType<typeof run>>) => new Map(report.results.map((r) => [r.id, r]));

describe("profiles", () => {
  it("defaults to muse-custom and leaves the Muse report unchanged", async () => {
    const report = await run("good/tasks-api.openapi.yaml");
    expect(report.profile).toEqual({ id: "muse-custom", title: "Muse custom connector" });
    expect(report.score.overall).toBe(100);
    expect(ids(report).has("MCP002")).toBe(false);
  });

  it("keeps muse as an alias for muse-custom", async () => {
    const aliased = await run("bad/auth001-oauth-only.openapi.yaml", { profile: "muse" });
    expect(aliased.profile.id).toBe("muse-custom");
    expect(aliased.gate.blocking).toContain("AUTH001");
  });

  it("blocks OAuth-only for custom connectors but not for a directory listing", async () => {
    const custom = await run("bad/auth001-oauth-only.openapi.yaml", { profile: "muse-custom" });
    const directory = ids(await run("bad/auth001-oauth-only.openapi.yaml", { profile: "muse-directory" }));
    expect(custom.gate.blocking).toContain("AUTH001");
    expect(directory.get("AUTH001")?.severity).toBe("low");
    expect(directory.get("AUTH002")?.severity).toBe("high"); // the implicit flow still matters
  });

  it("treats OAuth-only as a Muse blocker but correct for Claude", async () => {
    const muse = ids(await run("bad/auth001-oauth-only.openapi.yaml"));
    const claude = ids(await run("bad/auth001-oauth-only.openapi.yaml", { profile: "claude" }));
    expect(muse.get("AUTH001")?.status).toBe("fail");
    expect(claude.has("AUTH001")).toBe(false);
    expect(claude.get("AUTH002")?.severity).toBe("high");
  });

  it("requires tool titles and annotations for the Claude directory", async () => {
    const config = JSON.parse(readFileSync(fixture("good/notes-mcp.config.json"), "utf8"));
    const untitled = ids(await run("good/notes-mcp.tools.json", { ...config, profile: "claude" }));
    expect(untitled.get("MCP002")?.status).toBe("fail");
    expect(untitled.get("SCOPE002")?.severity).toBe("critical");

    const doc = JSON.parse(readFileSync(fixture("good/notes-mcp.tools.json"), "utf8"));
    doc.tools = doc.tools.map((t: { name: string }) => ({ ...t, title: t.name.replace(/_/g, " ") }));
    const file = join(mkdtempSync(join(tmpdir(), "muse-ready-prof-")), "tools.json");
    writeFileSync(file, JSON.stringify(doc));
    const titled = ids(await check(file, { config: { ...config, profile: "claude" } }));
    expect(titled.get("MCP002")?.status).toBe("pass");
  });

  it("lets the user's config override the profile", async () => {
    const report = ids(await run("bad/auth001-oauth-only.openapi.yaml", { profile: "claude", rules: { AUTH001: "high" } }));
    expect(report.get("AUTH001")?.severity).toBe("high");
  });

  it("rejects unknown profiles", async () => {
    expect(() => getProfile("chatgpt")).toThrow(/Unknown profile "chatgpt"/);
    await expect(run("good/tasks-api.openapi.yaml", { profile: "nope" })).rejects.toThrow(/Unknown profile/);
  });

  it("only overrides rules that exist, and explains every override", () => {
    const known = new Set(BUILTIN_RULES.map((r) => r.id));
    for (const p of Object.values(PROFILES)) {
      for (const rule of Object.keys(p.rules)) {
        expect(known.has(rule), `${p.id} overrides unknown rule ${rule}`).toBe(true);
        expect(p.reasons[rule], `${p.id} gives no reason for ${rule}`).toBeTruthy();
      }
    }
  });
});
