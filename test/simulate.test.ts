import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInput, parseScenarios } from "../src/index.js";
import { ModelError, validateModelConfig } from "../src/sim/client.js";
import { simulate } from "../src/sim/run.js";
import { buildTools, cleanSchema } from "../src/sim/tools.js";
import { fixture } from "./helpers.js";
import { call, careful, closeFakeModels, fakeModel, reckless } from "./fake-model.js";

const KEY = "sim-test-key-8c1f0e2d"; // gitleaks:allow (fake key the tests prove never leaks)
afterEach(async () => {
  vi.restoreAllMocks();
  await closeFakeModels();
});

const scenarios = () => parseScenarios(readFileSync(fixture("good/tasks-api.tasks.yaml"), "utf8")).scenarios;
const tasks = () => loadInput(fixture("good/tasks-api.openapi.yaml"));

describe("simulation", () => {
  it("passes a careful agent on every scenario, every run", async () => {
    const model = await fakeModel(careful);
    const result = await simulate(await tasks(), scenarios(), { model: { baseUrl: model.baseUrl, model: "fake-1", apiKey: KEY }, runs: 2 });
    expect(result.passRate).toBe(100);
    expect(result.scenarios.map((s) => [s.id, s.passed])).toEqual([["whats-on-my-list", 2], ["add-a-task", 2], ["look-up-one-task", 2], ["delete-needs-confirmation", 2]]);
    expect(result.scenarios[3]!.runs[0]!.reply).toContain("Are you sure");
  });

  it("catches an agent that deletes without asking", async () => {
    const model = await fakeModel(reckless);
    const result = await simulate(await tasks(), scenarios(), { model: { baseUrl: model.baseUrl, model: "fake-1" }, runs: 1 });
    const del = result.scenarios.find((s) => s.id === "delete-needs-confirmation")!;
    expect(del.passed).toBe(0);
    expect(del.runs[0]!.reasons).toEqual(["made write call DELETE /tasks/{taskId} instead of asking first"]);
    expect(result.passRate).toBe(75);
  });

  it("answers tool calls from the spec and sends nothing anywhere but the model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const model = await fakeModel(careful);
    await simulate(await tasks(), scenarios().slice(0, 1), { model: { baseUrl: model.baseUrl, model: "fake-1" }, runs: 1 });
    for (const [url] of fetchSpy.mock.calls) expect(String(url)).toMatch(new RegExp(`^${model.baseUrl}/`));
    const toolReply = model.seen[1]!.body.messages.at(-1);
    expect(toolReply.role).toBe("tool");
    expect(JSON.parse(toolReply.content)).toMatchObject({ status: 200, body: { items: [{ id: "example", title: "example", done: true }] } });
    expect(model.seen[0]!.body.tools.map((t: any) => t.function.name)).toEqual(["listTasks", "createTask", "getTask", "deleteTask"]);
  });

  it("sends the key only as a bearer header, and never reports it", async () => {
    const ok = await fakeModel(careful);
    const result = await simulate(await tasks(), scenarios().slice(0, 1), { model: { baseUrl: ok.baseUrl, model: "fake-1", apiKey: KEY }, runs: 1 });
    expect(ok.seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(ok.seen[0]!.body)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);

    const denied = await fakeModel(careful, 401);
    const bad = await simulate(await tasks(), scenarios().slice(0, 2), { model: { baseUrl: denied.baseUrl, model: "fake-1", apiKey: KEY }, runs: 3 });
    expect(bad.scenarios[0]!.runs).toHaveLength(1); // an auth failure doesn't burn every run
    expect(bad.scenarios[0]!.runs[0]!.error).toBe("Model endpoint returned HTTP 401: check MUSE_READY_LLM_KEY.");
    expect(JSON.stringify(bad)).not.toContain(KEY);
  });

  it("stops an agent that never finishes", async () => {
    const model = await fakeModel(() => call("getTask", { taskId: "t_1" }));
    const r = await simulate(await tasks(), scenarios().slice(0, 1), { model: { baseUrl: model.baseUrl, model: "fake-1" }, runs: 1, maxTurns: 3 });
    expect(r.scenarios[0]!.runs[0]!.turns).toBe(3);
    expect(r.scenarios[0]!.runs[0]!.reasons).toContain("stopped after 3 turns");
  });
});

describe("model configuration", () => {
  it("refuses contributor tiers, plain HTTP to remote hosts and keys in URLs", () => {
    expect(() => validateModelConfig({ baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3-contributor" })).toThrow(/train on your prompts/);
    expect(() => validateModelConfig({ baseUrl: "http://api.example.com/v1", model: "m" })).toThrow(/HTTPS/);
    expect(() => validateModelConfig({ baseUrl: "https://user:secret@api.example.com/v1", model: "m" })).toThrow(ModelError);
    expect(() => validateModelConfig({ baseUrl: "https://api.example.com/v1", model: "" })).toThrow(/No model/);
    expect(() => validateModelConfig({ baseUrl: "http://127.0.0.1:11434/v1", model: "llama" })).not.toThrow();
    expect(() => validateModelConfig({ baseUrl: "http://localhost:11434/v1", model: "llama" })).not.toThrow();
  });
});

describe("tool definitions", () => {
  it("maps operations to tools with required path params and flattened JSON bodies", async () => {
    const tools = buildTools(await tasks());
    const create = tools.find((t) => t.name === "createTask")!;
    expect(create).toMatchObject({ label: "POST /tasks", write: true });
    expect((create.parameters as any).properties.title.type).toBe("string");
    expect((create.parameters as any).required).toContain("title");
    const get = tools.find((t) => t.name === "getTask")!;
    expect((get.parameters as any).required).toEqual(["taskId"]);
    expect(get.write).toBe(false);
  });

  it("survives circular schemas", () => {
    const node: any = { type: "object", properties: {} };
    node.properties.child = node;
    expect(() => JSON.stringify(cleanSchema(node))).not.toThrow();
  });

  it("builds MCP tools and marks read-only ones", async () => {
    const tools = buildTools(await loadInput(fixture("good/notes-mcp.tools.json")));
    expect(tools.map((t) => [t.name, t.write])).toEqual([["search_notes", false], ["delete_note", true]]);
  });
});
