// GitHub Action entry point. Reads inputs from INPUT_* environment variables (no @actions/* dependency),
// makes no GitHub API calls and needs no token. Bundled into action/dist/index.mjs by scripts/build-action.mjs.
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../core/config.js";
import { connectorFrom, runRules } from "../core/engine.js";
import { loadInput } from "../core/load.js";
import { renderBadge } from "../report/badge.js";
import { renderMarkdown } from "../report/markdown.js";
import { renderSarif } from "../report/sarif.js";
import { renderTerminal } from "../report/terminal.js";
import { TOKEN_ENV, authHeaders } from "../probe/auth.js";
import { runProbe } from "../probe/run.js";
import { BUILTIN_RULES } from "../rules/index.js";
import { getProfile } from "../core/profiles.js";
import { runSimulation } from "../sim/entry.js";

export class InputError extends Error {}

/** GitHub keeps hyphens in input env names: `fail-under` becomes INPUT_FAIL-UNDER. */
export function input(env: NodeJS.ProcessEnv, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

/** File inputs must be plain paths: no control characters that could smuggle extra outputs or commands. */
export function pathInput(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  const value = input(env, name) || fallback;
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new InputError(`Input "${name}" contains control characters.`);
  return value;
}

/** Workflow-command escaping for ::error:: messages. */
export function escapeCommand(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Writes name=value pairs to $GITHUB_OUTPUT using a random heredoc delimiter, so no value can inject another output. */
export function setOutputs(file: string | undefined, values: Record<string, string>): void {
  if (!file) return;
  let text = "";
  for (const [name, value] of Object.entries(values)) {
    let delimiter = `ghadelimiter_${randomUUID()}`;
    while (value.includes(delimiter)) delimiter = `ghadelimiter_${randomUUID()}`;
    text += `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  appendFileSync(file, text);
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const spec = pathInput(env, "spec");
  if (!spec) throw new InputError('Input "spec" is required: a path or URL to an OpenAPI document or MCP tool list.');
  const configPath = pathInput(env, "config");
  const sarifFile = pathInput(env, "sarif-file", "muse-ready.sarif");
  const badgeFile = pathInput(env, "badge-file");
  const failUnderRaw = input(env, "fail-under");
  const failUnder = failUnderRaw === "" ? undefined : Number(failUnderRaw);
  if (failUnder !== undefined && !(failUnder >= 0 && failUnder <= 100)) throw new InputError('Input "fail-under" must be a number from 0 to 100.');
  const probeRaw = input(env, "probe").toLowerCase() || "false";
  if (!["true", "false"].includes(probeRaw)) throw new InputError('Input "probe" must be true or false.');
  const probeMcpRaw = input(env, "probe-mcp").toLowerCase() || "false";
  if (!["true", "false"].includes(probeMcpRaw)) throw new InputError('Input "probe-mcp" must be true or false.');

  const at = (p: string) => (/^https?:\/\//i.test(p) ? p : resolve(workspace, p));
  const loadedConfig = await loadConfig(configPath ? at(configPath) : undefined, workspace);
  const profileInput = input(env, "profile");
  const config = profileInput ? { ...loadedConfig, profile: profileInput } : loadedConfig;
  getProfile(config.profile); // fails fast on an unknown profile
  const source = at(spec);
  const loaded = await loadInput(source);
  const token = env[TOKEN_ENV];
  const probe =
    probeRaw === "true" || probeMcpRaw === "true"
      ? await runProbe(loaded, connectorFrom(loaded, config), {
          authHeaders: token ? authHeaders(token, loaded, config.probe?.authHeader) : undefined,
          mcp: probeMcpRaw === "true",
        })
      : undefined;
  const simulateRaw = input(env, "simulate").toLowerCase() || "false";
  if (!["true", "false"].includes(simulateRaw)) throw new InputError('Input "simulate" must be true or false.');
  const simulation =
    simulateRaw === "true"
      ? await runSimulation(loaded, config, {
          tasksFile: at(pathInput(env, "tasks-file", config.simulate?.tasks ?? "muse-ready.tasks.yaml")),
          model: input(env, "model") || undefined,
          baseUrl: input(env, "model-base-url") || undefined,
          env,
        })
      : undefined;
  const report = await runRules(loaded, BUILTIN_RULES, config, probe, simulation);

  const sarifPath = resolve(workspace, sarifFile);
  writeFileSync(sarifPath, JSON.stringify(renderSarif(report, workspace), null, 2) + "\n");
  if (badgeFile) writeFileSync(resolve(workspace, badgeFile), JSON.stringify(renderBadge(report), null, 2) + "\n");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
  setOutputs(env.GITHUB_OUTPUT, {
    score: String(report.score.overall),
    grade: report.score.grade,
    passed: String(report.gate.passed && (failUnder === undefined || report.score.overall >= failUnder)),
    "sarif-file": sarifFile,
    ...(report.simulation ? { "scenario-pass-rate": String(report.simulation.passRate) } : {}),
  });

  console.log(renderTerminal(report, { color: false }));
  const threshold = failUnder ?? config.failUnder;
  if (!report.gate.passed) {
    console.log(`::error::${escapeCommand(`muse-ready: blocked by ${report.gate.blocking.join(", ")}`)}`);
    return 1;
  }
  if (threshold !== undefined && report.score.overall < threshold) {
    console.log(`::error::${escapeCommand(`muse-ready: score ${report.score.overall} is below fail-under ${threshold}`)}`);
    return 1;
  }
  return 0;
}

// Run only when executed directly (the bundle), not when imported by tests.
if (process.env.MUSE_READY_ACTION_RUN === "1" || process.argv[1]?.endsWith("action/dist/index.mjs")) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.log(`::error::${escapeCommand(`muse-ready: ${err instanceof Error ? err.message : String(err)}`)}`);
      process.exitCode = 1;
    },
  );
}
