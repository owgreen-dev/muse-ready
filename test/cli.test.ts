import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { fixture, root } from "./helpers.js";

const exec = promisify(execFile);
const cli = join(root, "dist/cli/index.js");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec("node", [cli, ...args], { cwd: root });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("cli", () => {
  beforeAll(async () => {
    await exec("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: root });
  }, 120_000);

  it("exits 0 for a ready spec and prints the score", async () => {
    const { code, stdout } = await runCli([fixture("good/tasks-api.openapi.yaml"), "--no-color"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Readiness 100/100 A+");
  });

  it("exits 1 on a blocking failure", async () => {
    const { code, stdout } = await runCli([fixture("bad/net001-localhost.openapi.yaml"), "--no-color"]);
    expect(code).toBe(1);
    expect(stdout).toContain("Blocked by NET001");
  });

  it("exits 1 below --fail-under even without blocking failures", async () => {
    const { code } = await runCli([fixture("bad/page001-unbounded.openapi.yaml"), "--fail-under", "99"]);
    expect(code).toBe(1);
  });

  it("exits 2 when the input cannot be loaded", async () => {
    const { code, stderr } = await runCli(["does-not-exist.yaml"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Cannot read");
  });

  it("prints JSON and writes every side-output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-ready-"));
    const out = (n: string) => join(dir, n);
    const { stdout } = await runCli([
      fixture("good/tasks-api.openapi.yaml"), "-f", "json",
      "--json", out("r.json"), "--md", out("r.md"), "--sarif", out("r.sarif"), "--badge", out("b.json"),
    ]);
    expect(JSON.parse(stdout).score.overall).toBe(100);
    expect(JSON.parse(readFileSync(out("r.json"), "utf8")).input.kind).toBe("openapi");
    expect(readFileSync(out("r.md"), "utf8")).toContain("Muse readiness");
    expect(JSON.parse(readFileSync(out("r.sarif"), "utf8")).version).toBe("2.1.0");
    expect(JSON.parse(readFileSync(out("b.json"), "utf8")).schemaVersion).toBe(1);
  });

  it("lists rules", async () => {
    const { stdout } = await runCli(["--list-rules"]);
    expect(stdout.trim().split("\n")).toHaveLength(16);
  });
});
