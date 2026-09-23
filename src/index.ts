import { loadConfig, type Config } from "./core/config.js";
import { runRules } from "./core/engine.js";
import { loadInput } from "./core/load.js";
import type { InputKind, Report, Rule } from "./core/types.js";
import { BUILTIN_RULES } from "./rules/index.js";

export * from "./core/types.js";
export { loadInput, LoadError, detectKind } from "./core/load.js";
export { loadConfig, validateConfig, type Config } from "./core/config.js";
export { runRules } from "./core/engine.js";
export { computeScore, computeGate, grade, SEVERITY_WEIGHT, GATE_CATEGORIES } from "./core/score.js";
export { BUILTIN_RULES } from "./rules/index.js";
export { renderTerminal } from "./report/terminal.js";
export { renderMarkdown } from "./report/markdown.js";
export { renderSarif } from "./report/sarif.js";
export { renderBadge } from "./report/badge.js";

export interface CheckOptions {
  config?: Config;
  configPath?: string;
  kind?: InputKind;
  rules?: Rule[];
}

/** Load a spec from a path or URL and run every rule against it. */
export async function check(source: string, opts: CheckOptions = {}): Promise<Report> {
  const config = opts.config ?? (await loadConfig(opts.configPath));
  const input = await loadInput(source, opts.kind);
  return runRules(input, opts.rules ?? BUILTIN_RULES, config);
}
