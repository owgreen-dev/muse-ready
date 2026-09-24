import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
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

  it("--probe-allow-private probes a local API with GET only and prints a summary", async () => {
    const { createServer } = await import("node:http");
    const { writeFileSync } = await import("node:fs");
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.method ?? "");
      res.end("[]");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const port = (server.address() as import("node:net").AddressInfo).port;
      const dir = mkdtempSync(join(tmpdir(), "muse-ready-cli-probe-"));
      const spec = join(dir, "openapi.json");
      writeFileSync(spec, JSON.stringify({
        openapi: "3.1.0", info: { title: "Local", version: "1" }, servers: [{ url: `http://127.0.0.1:${port}` }],
        paths: { "/items": { get: { operationId: "listItems", summary: "List items", responses: { "200": { description: "ok" } } },
                             delete: { operationId: "deleteItems", summary: "Delete items", responses: { "204": { description: "gone" } } } } },
      }));
      const { stdout, stderr } = await runCli([spec, "--probe-allow-private", "--no-color"]);
      expect(stderr).toContain("read-only GET");
      expect(stdout).toMatch(/Probe: \d+ GET requests? to http:\/\/127\.0\.0\.1:\d+\/, \d+ answered\./);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((m) => m === "GET")).toBe(true);
    } finally {
      server.close();
    }
  });

  it("--profile changes the target platform and --list-profiles explains them", async () => {
    const { stdout } = await runCli([fixture("bad/auth001-oauth-only.openapi.yaml"), "--profile", "claude", "--no-color"]);
    expect(stdout).toContain("profile claude");
    expect(stdout).not.toContain("AUTH001");
    const listed = await runCli(["--list-profiles"]);
    for (const p of ["muse", "claude", "openai-apps", "gemini", "mcp"]) expect(listed.stdout).toContain(p);
    expect((await runCli([fixture("good/tasks-api.openapi.yaml"), "--profile", "nope"])).code).not.toBe(0);
  });

  it("lists rules", async () => {
    const { stdout } = await runCli(["--list-rules"]);
    expect(stdout.trim().split("\n")).toHaveLength(22);
  });
});
