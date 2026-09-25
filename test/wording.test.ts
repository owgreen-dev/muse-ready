import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderMarkdown, renderSarif, renderTerminal } from "../src/index.js";
import { fixture, result, run } from "./helpers.js";

const files = ["good", "bad"].flatMap((dir) =>
  readdirSync(fixture(dir))
    .filter((f) => !f.endsWith(".config.json") && !f.endsWith(".tasks.yaml"))
    .map((f) => `${dir}/${f}`),
);

describe("report wording", () => {
  it.each(files)("%s renders without '(s)' or 'All 1 '", async (file) => {
    const config = file === "good/notes-mcp.tools.json" ? JSON.parse(readFileSync(fixture("good/notes-mcp.config.json"), "utf8")) : {};
    const report = await run(file, config);
    const text = [
      renderTerminal(report, { color: false, verbose: true }),
      renderMarkdown(report),
      JSON.stringify(renderSarif(report)),
      ...report.results.flatMap((r) => [r.message, ...r.findings.map((f) => f.message)]),
    ].join("\n");
    expect(text).not.toContain("(s)");
    expect(text).not.toContain("All 1 ");
  });

  it("META001 separates required from recommended gaps", async () => {
    const bare = result(await run("bad/meta001-no-listing.openapi.yaml"), "META001");
    expect(bare.message).toBe("8 required fields missing, 1 recommended.");

    const oneEach = result(
      await run("bad/meta001-no-listing.openapi.yaml", {
        connector: {
          description: "A long enough description of what this connector does for people.",
          websiteUrl: "https://example.com",
          examplePrompts: ["Ping the service", "Is the API up?", "Check status"],
          iconUrl: "https://example.com/icon.png",
          supportEmail: "help@example.com",
          privacyPolicyUrl: "https://example.com/privacy",
          termsUrl: "https://example.com/terms",
        },
      }),
      "META001",
    );
    expect(oneEach.message).toBe("1 required field missing, 1 recommended.");
  });

  it("uses singular phrasing for a single item", async () => {
    const r = result(await run("good/tasks-api.openapi.yaml"), "SCOPE003");
    expect(r.message).toBe("The 1 high-impact action takes a confirm or dry-run parameter.");
  });
});
