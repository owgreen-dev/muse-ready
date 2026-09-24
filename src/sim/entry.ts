import { readFile } from "node:fs/promises";
import type { Config } from "../core/config.js";
import type { LoadedInput, Report } from "../core/types.js";
import { KEY_ENV, ModelError, validateModelConfig } from "./client.js";
import { simulate } from "./run.js";
import { ScenarioError, checkAgainstSpec, parseScenarios } from "./scenarios.js";

export const DEFAULT_TASKS_FILE = "muse-ready.tasks.yaml";

export class SimulationSetupError extends Error {}

export interface SimulationRequest {
  tasksFile?: string;
  model?: string;
  baseUrl?: string;
  runs?: number;
  env?: NodeJS.ProcessEnv;
}

function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || h.startsWith("127.");
  } catch {
    return false;
  }
}

/** Loads scenarios, checks configuration and runs the simulation. Throws SimulationSetupError with a fix-it message. */
export async function runSimulation(input: LoadedInput, config: Config, req: SimulationRequest): Promise<NonNullable<Report["simulation"]>> {
  const env = req.env ?? process.env;
  const tasksFile = req.tasksFile ?? config.simulate?.tasks ?? DEFAULT_TASKS_FILE;
  const model = req.model ?? config.simulate?.model;
  const baseUrl = req.baseUrl ?? config.simulate?.baseUrl;
  const apiKey = env[KEY_ENV] || undefined;
  if (!model || !baseUrl) {
    throw new SimulationSetupError(
      `--simulate needs a model and an OpenAI-compatible base URL: pass --model and --model-base-url, or set simulate.model and simulate.baseUrl in the config. Put the key in ${KEY_ENV}.`,
    );
  }
  if (!apiKey && !isLocalUrl(baseUrl)) throw new SimulationSetupError(`--simulate needs ${KEY_ENV} set for ${new URL(baseUrl).host}.`);
  try {
    validateModelConfig({ baseUrl, model });
  } catch (err) {
    if (err instanceof ModelError) throw new SimulationSetupError(err.message);
    throw err;
  }
  let text: string;
  try {
    text = await readFile(tasksFile, "utf8");
  } catch {
    throw new SimulationSetupError(`No scenario file at ${tasksFile}. Create one with --init-tasks ${tasksFile}.`);
  }
  let file;
  try {
    file = parseScenarios(text, tasksFile);
    const problems = checkAgainstSpec(file, input, tasksFile);
    if (problems.length) throw new ScenarioError(problems);
  } catch (err) {
    if (err instanceof ScenarioError) throw new SimulationSetupError(err.problems.join("\n"));
    throw err;
  }
  const result = await simulate(input, file.scenarios, { model: { baseUrl, model, apiKey }, runs: req.runs ?? config.simulate?.runs ?? 3 });
  const lines = new Map(file.scenarios.map((s) => [s.id, s.line]));
  return {
    model: result.model,
    runs: result.runs,
    passRate: result.passRate,
    tasksFile,
    scenarios: result.scenarios.map((s) => ({
      id: s.id,
      request: s.request,
      line: lines.get(s.id),
      passed: s.passed,
      runs: s.runs.map(({ error: _e, ...r }) => r),
    })),
  };
}
