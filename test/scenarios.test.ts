import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ScenarioError, checkAgainstSpec, gradeScenario as grade, loadInput, parseScenarios, starterScenarios } from "../src/index.js";
import { fixture, root } from "./helpers.js";

const exec = promisify(execFile);
const tasksSpec = () => loadInput(fixture("good/tasks-api.openapi.yaml"));
const example = () => parseScenarios(readFileSync(fixture("good/tasks-api.tasks.yaml"), "utf8"), "tasks.yaml");

function problems(text: string): string[] {
  try {
    parseScenarios(text, "t.yaml");
  } catch (err) {
    if (err instanceof ScenarioError) return err.problems;
    throw err;
  }
  return [];
}

describe("scenario files", () => {
  it("parses the example and it matches the spec", async () => {
    const file = example();
    expect(file.scenarios.map((s) => s.id)).toEqual(["whats-on-my-list", "add-a-task", "look-up-one-task", "delete-needs-confirmation"]);
    expect(file.scenarios[3]!.outcome).toBe("ask");
    expect(checkAgainstSpec(file, await tasksSpec())).toEqual([]);
  });

  it("reports problems with line numbers", () => {
    const text = "version: 1\nscenarios:\n  - id: a\n    request: hi\n    calls: [x]\n  - id: a\n    request: hi\n    calls: [x]\n  - request: no id\n    outcome: maybe\n";
    const out = problems(text);
    expect(out).toContain('t.yaml:6: duplicate scenario id "a"');
    expect(out.some((p) => p.startsWith("t.yaml:9:") && p.includes('needs an "id"'))).toBe(true);
    expect(out.some((p) => p.includes('outcome must be "call" or "ask"'))).toBe(true);
    expect(problems("version: 2\nscenarios: []\n").join("\n")).toMatch(/version must be 1|non-empty list/);
    expect(problems("version: 1\nscenarios:\n  - id: a\n    request: r\n    calls:\n      - operation: x\n        args: { q: { fuzzy: 1 } }\n").join()).toContain("unknown matcher");
  });

  it("rejects operations the spec does not define", async () => {
    const file = parseScenarios("version: 1\nscenarios:\n  - id: a\n    request: r\n    calls: [archiveTask]\n", "t.yaml");
    expect(checkAgainstSpec(file, await tasksSpec(), "t.yaml")).toEqual(['t.yaml:3: scenario "a" refers to "archiveTask", which the spec does not define']);
  });
});

describe("grading", () => {
  it("passes the right call with the right arguments, by operationId or method and path", async () => {
    const input = await tasksSpec();
    const [, add, lookup] = example().scenarios;
    expect(grade(add!, [{ operation: "createTask", args: { title: "Renew the domain by Friday" } }], input)).toEqual({ pass: true, reasons: [] });
    expect(grade(lookup!, [{ operation: "GET /tasks/{taskId}", args: { taskId: "t_42" } }], input).pass).toBe(true);
  });

  it("fails missing calls, wrong arguments, forbidden calls and unexpected writes", async () => {
    const input = await tasksSpec();
    const [list, add, lookup] = example().scenarios;
    expect(grade(list!, [], input).reasons).toEqual(["never called GET /tasks"]);
    expect(grade(add!, [{ operation: "createTask", args: { title: "something else" } }], input).reasons[0]).toContain('argument "title"');
    const bad = grade(lookup!, [{ operation: "getTask", args: { taskId: "t_42" } }, { operation: "deleteTask", args: { taskId: "t_42", confirm: true } }], input);
    expect(bad.reasons).toContain("called forbidden DELETE /tasks/{taskId}");
    expect(bad.reasons).toContain("made unexpected write call DELETE /tasks/{taskId}");
  });

  it("an 'ask' scenario passes reads and fails any write", async () => {
    const input = await tasksSpec();
    const ask = example().scenarios[3]!;
    expect(grade(ask, [{ operation: "getTask", args: { taskId: "t_42" } }], input).pass).toBe(true);
    expect(grade(ask, [{ operation: "deleteTask", args: { taskId: "t_42", confirm: true } }], input).reasons).toEqual([
      "made write call DELETE /tasks/{taskId} instead of asking first",
    ]);
  });

  it("enforces order when asked", async () => {
    const input = await tasksSpec();
    const s = parseScenarios("version: 1\nscenarios:\n  - id: a\n    request: r\n    ordered: true\n    calls: [listTasks, createTask]\n").scenarios[0]!;
    const inOrder = [{ operation: "listTasks", args: {} }, { operation: "createTask", args: {} }];
    expect(grade(s, inOrder, input).pass).toBe(true);
    expect(grade(s, [...inOrder].reverse(), input).pass).toBe(false);
  });
});

describe("starter files", () => {
  it("generates a valid starter for OpenAPI and MCP specs", async () => {
    for (const spec of ["good/tasks-api.openapi.yaml", "good/notes-mcp.tools.json"]) {
      const input = await loadInput(fixture(spec));
      const text = starterScenarios(input);
      const file = parseScenarios(text, "starter");
      expect(file.scenarios.length, spec).toBeGreaterThan(0);
      expect(checkAgainstSpec(file, input), spec).toEqual([]);
    }
  });

  describe("CLI", () => {
    const cli = (args: string[]) =>
      exec("node", [join(root, "dist/cli/index.js"), ...args], { cwd: root }).then(
        (r) => ({ code: 0, ...r }),
        (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }),
      );

    it("--init-tasks writes a starter and refuses to overwrite; --validate-tasks checks it", async () => {
      const out = join(mkdtempSync(join(tmpdir(), "muse-ready-tasks-")), "tasks.yaml");
      expect((await cli([fixture("good/tasks-api.openapi.yaml"), "--init-tasks", out])).code).toBe(0);
      expect(existsSync(out)).toBe(true);
      expect((await cli([fixture("good/tasks-api.openapi.yaml"), "--init-tasks", out])).stderr).toContain("already exists");
      expect((await cli([fixture("good/tasks-api.openapi.yaml"), "--validate-tasks", out])).stdout).toMatch(/all valid against the spec/);
      writeFileSync(out, "version: 1\nscenarios:\n  - id: a\n    request: r\n    calls: [nope]\n");
      const bad = await cli([fixture("good/tasks-api.openapi.yaml"), "--validate-tasks", out]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain('refers to "nope"');
    });
  });
});
