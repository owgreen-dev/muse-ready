import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/index.js";
import { careful, closeFakeModels, fakeModel, reckless } from "./fake-model.js";
import { fixture, root } from "./helpers.js";

const execAsync = promisify(execFile);
afterEach(closeFakeModels);

async function cli(args: string[], env: Record<string, string> = {}, cwd = root) {
  try {
    const { stdout, stderr } = await execAsync("node", [join(root, "dist/cli/index.js"), ...args], { cwd, env: { ...process.env, MUSE_READY_LLM_KEY: "", ...env } });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code as number, stdout: err.stdout as string, stderr: err.stderr as string };
  }
}

const spec = fixture("good/tasks-api.openapi.yaml");
const tasks = fixture("good/tasks-api.tasks.yaml");

describe("--simulate", () => {
  it("explains what it needs instead of running unconfigured", async () => {
    const none = await cli([spec, "--simulate", tasks]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("needs a model and an OpenAI-compatible base URL");

    const noKey = await cli([spec, "--simulate", tasks, "--model", "m", "--model-base-url", "https://api.example.com/v1"]);
    expect(noKey.code).toBe(2);
    expect(noKey.stderr).toContain("needs MUSE_READY_LLM_KEY set for api.example.com");

    const contributor = await cli([spec, "--simulate", tasks, "--model", "muse-spark-1.3-contributor", "--model-base-url", "https://api.example.com/v1"], { MUSE_READY_LLM_KEY: "k" });
    expect(contributor.stderr).toContain("contributor tiers train on your prompts");

    const missing = await cli([spec, "--simulate", "nope.yaml", "--model", "m", "--model-base-url", "http://127.0.0.1:9/v1"]);
    expect(missing.stderr).toContain("No scenario file at nope.yaml");
  });

  it("runs scenarios and reports them in the terminal, JSON, Markdown and SARIF", async () => {
    const model = await fakeModel(reckless);
    const dir = mkdtempSync(join(tmpdir(), "muse-ready-sim-"));
    const args = [spec, "--simulate", tasks, "--model", "fake-1", "--model-base-url", model.baseUrl, "--runs", "1", "--no-color"];
    const term = await cli([...args, "--json", join(dir, "r.json"), "--md", join(dir, "r.md"), "--sarif", join(dir, "r.sarif")]);
    expect(term.code).toBe(0);
    expect(term.stdout).toContain("Scenario pass rate 75%");
    expect(term.stdout).toContain("made write call DELETE /tasks/{taskId} instead of asking first");

    const json = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
    expect(json.simulation).toMatchObject({ model: "fake-1", runs: 1, passRate: 75 });
    expect(readFileSync(join(dir, "r.md"), "utf8")).toContain("## Simulation");
    const sarif = JSON.parse(readFileSync(join(dir, "r.sarif"), "utf8")).runs[0];
    const sim = sarif.results.filter((r: any) => r.ruleId === "SIM001");
    expect(sim).toHaveLength(1);
    expect(sim[0].locations[0].physicalLocation.region.startLine).toBeGreaterThan(1);
    expect(sarif.tool.driver.rules[sim[0].ruleIndex].id).toBe("SIM001");
  });

  it("fails the run below simulate.minPassRate", async () => {
    const model = await fakeModel(reckless);
    const dir = mkdtempSync(join(tmpdir(), "muse-ready-sim-"));
    const cfg = join(dir, "muse-ready.config.json");
    writeFileSync(cfg, JSON.stringify({ simulate: { model: "fake-1", baseUrl: model.baseUrl, runs: 1, minPassRate: 90 } }));
    const r = await cli([spec, "--simulate", tasks, "-c", cfg]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("below simulate.minPassRate 90%");
    const ok = await fakeModel(careful);
    writeFileSync(cfg, JSON.stringify({ simulate: { model: "fake-1", baseUrl: ok.baseUrl, runs: 1, minPassRate: 90 } }));
    expect((await cli([spec, "--simulate", tasks, "-c", cfg])).code).toBe(0);
  });

  it("rejects model keys in the config file", () => {
    expect(() => validateConfig({ simulate: { apiKey: "x" } }, "cfg")).toThrow(/MUSE_READY_LLM_KEY/);
    expect(() => validateConfig({ simulate: { runs: 0 } }, "cfg")).toThrow(/1-20/);
  });

  it("runs from the GitHub Action and sets scenario-pass-rate", async () => {
    const model = await fakeModel(careful);
    const ws = mkdtempSync(join(tmpdir(), "muse-ready-action-sim-"));
    writeFileSync(join(ws, "out.txt"), "");
    const env = {
      PATH: process.env.PATH ?? "",
      GITHUB_WORKSPACE: ws,
      GITHUB_OUTPUT: join(ws, "out.txt"),
      INPUT_SPEC: spec,
      INPUT_SIMULATE: "true",
      "INPUT_TASKS-FILE": tasks,
      INPUT_MODEL: "fake-1",
      "INPUT_MODEL-BASE-URL": model.baseUrl,
    };
    const { stdout } = await execAsync("node", [join(root, "action/dist/index.mjs")], { cwd: ws, env });
    expect(stdout).toContain("Scenario pass rate 100%");
    expect(readFileSync(join(ws, "out.txt"), "utf8")).toMatch(/scenario-pass-rate<<(\S+)\n100\n\1/);
  });
});
