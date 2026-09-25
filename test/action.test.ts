import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { escapeCommand, setOutputs } from "../src/action/index.js";
import { fixture, root } from "./helpers.js";

const exec = promisify(execFile);
const entry = join(root, "action/dist/index.mjs");

/** Parses $GITHUB_OUTPUT the way the runner does: name=value lines and name<<DELIM heredocs. */
function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heredoc = line.match(/^([^=<]+)<<(.+)$/);
    if (heredoc) {
      const [, name, delim] = heredoc;
      const body: string[] = [];
      while (++i < lines.length && lines[i] !== delim) body.push(lines[i]!);
      out[name!] = body.join("\n");
    } else if (line.includes("=")) {
      out[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1);
    }
  }
  return out;
}

async function runAction(inputs: Record<string, string>) {
  const ws = mkdtempSync(join(tmpdir(), "muse-ready-action-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: ws,
    GITHUB_OUTPUT: join(ws, "output.txt"),
    GITHUB_STEP_SUMMARY: join(ws, "summary.md"),
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  writeFileSync(env.GITHUB_OUTPUT!, "");
  let code = 0;
  let stdout = "";
  try {
    ({ stdout } = await exec("node", [entry], { cwd: ws, env }));
  } catch (err: any) {
    code = err.code;
    stdout = err.stdout;
  }
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  return { ws, code, stdout, outputs: parseOutputs(read(env.GITHUB_OUTPUT!)), summary: read(env.GITHUB_STEP_SUMMARY!) };
}

describe("GitHub Action", () => {
  it("action.yml runs the committed bundle on node24 and declares the documented inputs and outputs", () => {
    const action = parse(readFileSync(join(root, "action.yml"), "utf8"));
    expect(action.runs).toEqual({ using: "node24", main: "action/dist/index.mjs" });
    expect(existsSync(entry)).toBe(true);
    expect(Object.keys(action.inputs)).toEqual(["spec", "config", "profile", "fail-under", "probe", "probe-mcp", "simulate", "tasks-file", "model", "model-base-url", "sarif-file", "badge-file"]);
    expect(action.inputs.spec.required).toBe(true);
    expect(action.inputs.probe.default).toBe("false");
    expect(Object.keys(action.outputs)).toEqual(["score", "grade", "passed", "sarif-file", "scenario-pass-rate"]);
  });

  it("writes outputs, the step summary, SARIF and a badge for a ready spec", async () => {
    const r = await runAction({ spec: fixture("good/tasks-api.openapi.yaml"), "badge-file": "badge.json" });
    expect(r.code).toBe(0);
    expect(r.outputs).toEqual({ score: "100", grade: "A+", passed: "true", "sarif-file": "muse-ready.sarif" });
    expect(r.summary).toContain("# Muse custom connector readiness: Tasks API");
    expect(JSON.parse(readFileSync(join(r.ws, "muse-ready.sarif"), "utf8")).version).toBe("2.1.0");
    expect(JSON.parse(readFileSync(join(r.ws, "badge.json"), "utf8")).message).toBe("100/100 A+");
    expect(r.stdout).toContain("Readiness 100/100 A+");
  });

  it("fails the step on a blocking failure and on fail-under", async () => {
    const blocked = await runAction({ spec: fixture("bad/net001-localhost.openapi.yaml") });
    expect(blocked.code).toBe(1);
    expect(blocked.outputs.passed).toBe("false");
    expect(blocked.stdout).toContain("::error::muse-ready: blocked by NET001");

    const low = await runAction({ spec: fixture("bad/page001-unbounded.openapi.yaml"), "fail-under": "99" });
    expect(low.code).toBe(1);
    expect(low.outputs.passed).toBe("false");
    expect(low.stdout).toMatch(/::error::muse-ready: score \d+ is below fail-under 99/);
  });

  it("rejects bad inputs before writing anything", async () => {
    const injected = await runAction({ spec: fixture("good/tasks-api.openapi.yaml"), "sarif-file": "x.sarif\npassed=true" });
    expect(injected.code).toBe(1);
    expect(injected.stdout).toContain("::error::muse-ready: Input \"sarif-file\" contains control characters.");
    expect(injected.outputs).toEqual({});
    expect((await runAction({})).stdout).toContain('Input "spec" is required');
    expect((await runAction({ spec: fixture("good/tasks-api.openapi.yaml"), probe: "yes" })).stdout).toContain('"probe" must be true or false');
    expect((await runAction({ spec: fixture("good/tasks-api.openapi.yaml"), "fail-under": "abc" })).stdout).toContain('"fail-under" must be a number');
  });

  it("output values cannot inject extra outputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-ready-out-"));
    const file = join(dir, "out.txt");
    writeFileSync(file, "");
    setOutputs(file, { grade: "A\npassed=true\nEOF\npassed<<EOF\ntrue" });
    expect(parseOutputs(readFileSync(file, "utf8"))).toEqual({ grade: "A\npassed=true\nEOF\npassed<<EOF\ntrue" });
    expect(escapeCommand("a%b\r\n::error::x")).toBe("a%25b%0D%0A::error::x");
  });

  it("makes no GitHub API calls and needs no token", () => {
    const source = readFileSync(join(root, "src/action/index.ts"), "utf8");
    expect(source).not.toMatch(/api\.github\.com|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|\bfetch\s*\(/);
  });

  it("the committed bundle is up to date with the source", async () => {
    const { bundle } = await import("../scripts/build-action.mjs");
    const fresh: string = await bundle(false);
    expect(fresh === readFileSync(entry, "utf8"), "action/dist/index.mjs is stale: run npm run build:action").toBe(true);
  });
});
