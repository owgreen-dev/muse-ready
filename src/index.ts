import { loadConfig, type Config } from "./core/config.js";
import { connectorFrom, runRules } from "./core/engine.js";
import { runProbe, type ProbeOptions } from "./probe/run.js";
import { loadInput } from "./core/load.js";
import type { InputKind, Report, Rule } from "./core/types.js";
import { BUILTIN_RULES } from "./rules/index.js";

export * from "./core/types.js";
export { loadInput, LoadError, detectKind } from "./core/load.js";
export { loadConfig, validateConfig, type Config } from "./core/config.js";
export { runRules, connectorFrom } from "./core/engine.js";
export { runProbe, type ProbeOptions } from "./probe/run.js";
export { authHeaders, TOKEN_ENV } from "./probe/auth.js";
export { computeScore, computeGate, grade, SEVERITY_WEIGHT, GATE_CATEGORIES } from "./core/score.js";
export { BUILTIN_RULES } from "./rules/index.js";
export { runSimulation, SimulationSetupError } from "./sim/entry.js";
export { simulate, type SimulationResult } from "./sim/run.js";
export { parseScenarios, checkAgainstSpec, grade as gradeScenario, starterScenarios, ScenarioError, type Scenario, type ScenarioFile, type ActualCall, type Grade } from "./sim/scenarios.js";
export { PROFILES, PROFILE_ALIASES, getProfile, DEFAULT_PROFILE, type Profile } from "./core/profiles.js";
export { renderTerminal } from "./report/terminal.js";
export { renderMarkdown } from "./report/markdown.js";
export { renderSarif } from "./report/sarif.js";
export { renderBadge } from "./report/badge.js";

export interface CheckOptions {
  config?: Config;
  configPath?: string;
  kind?: InputKind;
  rules?: Rule[];
  /** Run live checks against the declared server. Off by default. */
  probe?: boolean | ProbeOptions;
}

/** Load a spec from a path or URL and run every rule against it. */
export async function check(source: string, opts: CheckOptions = {}): Promise<Report> {
  const config = opts.config ?? (await loadConfig(opts.configPath));
  const input = await loadInput(source, opts.kind);
  const probe = opts.probe ? await runProbe(input, connectorFrom(input, config), opts.probe === true ? {} : opts.probe) : undefined;
  return runRules(input, opts.rules ?? BUILTIN_RULES, config, probe);
}
