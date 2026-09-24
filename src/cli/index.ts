#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import { ScenarioError, checkAgainstSpec, parseScenarios, starterScenarios } from "../sim/scenarios.js";
import { SimulationSetupError, runSimulation } from "../sim/entry.js";
import type { Report } from "../core/types.js";
import { Command, InvalidArgumentError, Option } from "commander";
import { loadConfig } from "../core/config.js";
import { connectorFrom, runRules } from "../core/engine.js";
import { TOKEN_ENV, authHeaders } from "../probe/auth.js";
import { runProbe } from "../probe/run.js";
import { LoadError, loadInput } from "../core/load.js";
import { RULESET_DATE, TOOL_VERSION } from "../core/version.js";
import { renderBadge } from "../report/badge.js";
import { renderMarkdown } from "../report/markdown.js";
import { renderSarif } from "../report/sarif.js";
import { renderTerminal } from "../report/terminal.js";
import { BUILTIN_RULES } from "../rules/index.js";
import { PROFILES, getProfile } from "../core/profiles.js";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_ERROR = 2;

function score(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new InvalidArgumentError("must be a number from 0 to 100");
  return n;
}

const program = new Command()
  .name("muse-ready")
  .description("Check whether an OpenAPI spec or MCP tool list is ready to become a Meta Muse connector.")
  .version(TOOL_VERSION)
  .argument("[source]", "path or URL of an OpenAPI document (JSON/YAML) or an MCP tools/list result")
  .addOption(new Option("-f, --format <format>", "what to print to stdout").choices(["terminal", "json", "md", "sarif"]).default("terminal"))
  .option("--json <file>", "also write the JSON report to a file")
  .option("--md <file>", "also write a Markdown report to a file")
  .option("--sarif <file>", "also write SARIF for GitHub code scanning to a file")
  .option("--badge <file>", "also write shields.io endpoint JSON for a README badge")
  .addOption(new Option("-p, --profile <profile>", "target platform").choices(Object.keys(PROFILES)))
  .option("--list-profiles", "print the platform profiles and how they change the rules, then exit")
  .addOption(new Option("--kind <kind>", "input type, if auto-detection guesses wrong").choices(["openapi", "mcp"]))
  .option("-c, --config <file>", "config file (default: muse-ready.config.{json,yaml,yml} in the current directory)")
  .option("--fail-under <score>", "exit 1 when the overall score is below this", score)
  .option("--probe", "also make read-only GET requests to the declared server to check DNS, TLS, latency, auth errors and list sizes")
  .option("--probe-allow-private", "let --probe reach localhost, private networks and plain HTTP (local testing only)")
  .option("--no-color", "disable colors")
  .option("-v, --verbose", "also list rules that do not apply")
  .option("--list-rules", "print the rule catalog and exit")
  .option("--simulate [tasks-file]", "run scenarios with a model playing the agent (default file: muse-ready.tasks.yaml); tool calls are answered from the spec, never your API")
  .option("--model <id>", "model for --simulate, e.g. muse-spark-1.3")
  .option("--model-base-url <url>", "OpenAI-compatible base URL for --simulate; key goes in MUSE_READY_LLM_KEY")
  .option("--runs <n>", "runs per scenario for --simulate (default 3)", (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new InvalidArgumentError("must be 1-20");
    return n;
  })
  .option("--init-tasks <file>", "write a starter scenario file for the spec, for Readiness Pro simulation")
  .option("--validate-tasks <file>", "check a scenario file against the spec and exit")
  .addHelpText(
    "after",
    `
Exit codes: 0 ready, 1 blocking failure or score below --fail-under, 2 could not run.
--probe attaches $MUSE_READY_TOKEN, if set, to secured operations only, and only on the target's own origin.
Ruleset reflects public evidence about Muse as of ${RULESET_DATE}.

Examples:
  npx muse-ready ./openapi.yaml
  npx muse-ready https://api.example.com/openapi.json --sarif muse.sarif --badge badge.json
  npx muse-ready tools.json --kind mcp -f json`,
  );

async function main(): Promise<number> {
  program.parse();
  const opts = program.opts();
  const [source] = program.args;

  if (opts.listRules) {
    for (const r of BUILTIN_RULES) {
      console.log(`${r.id.padEnd(9)} ${r.severity.padEnd(8)} ${r.category.padEnd(11)} ${r.title}`);
    }
    return EXIT_OK;
  }
  if (opts.listProfiles) {
    for (const p of Object.values(PROFILES)) {
      console.log(`${p.id.padEnd(12)} ${p.title}: ${p.description}`);
      for (const [rule, setting] of Object.entries(p.rules)) console.log(`${"".padEnd(12)}   ${rule} ${setting}: ${p.reasons[rule] ?? ""}`);
    }
    return EXIT_OK;
  }
  if (!source) {
    program.help({ error: true });
  }

  let config;
  try {
    config = await loadConfig(opts.config);
  } catch (err) {
    console.error(`muse-ready: bad config: ${(err as Error).message}`);
    return EXIT_ERROR;
  }

  if (opts.profile) config = { ...config, profile: opts.profile };
  try {
    getProfile(config.profile);
  } catch (err) {
    console.error(`muse-ready: ${(err as Error).message}`);
    return EXIT_ERROR;
  }

  let input;
  try {
    input = await loadInput(source!, opts.kind);
  } catch (err) {
    if (err instanceof LoadError) {
      console.error(`muse-ready: ${err.message}`);
      return EXIT_ERROR;
    }
    throw err;
  }

  let probe;
  if (opts.probe || opts.probeAllowPrivate) {
    const connector = connectorFrom(input, config);
    const token = process.env[TOKEN_ENV];
    if (opts.format === "terminal") {
      console.error(`Probing with read-only GET requests${token ? ` (authenticated with ${TOKEN_ENV})` : ""}…`);
    }
    probe = await runProbe(input, connector, {
      authHeaders: token ? authHeaders(token, input, config.probe?.authHeader) : undefined,
      request: opts.probeAllowPrivate ? { allowPrivateNetwork: true, allowInsecureHttp: true } : {},
    });
  }
  if (opts.initTasks) {
    try {
      await access(opts.initTasks);
      console.error(`muse-ready: ${opts.initTasks} already exists; not overwriting it.`);
      return EXIT_ERROR;
    } catch {
      /* does not exist: good */
    }
    await writeFile(opts.initTasks, starterScenarios(input));
    console.log(`Wrote ${opts.initTasks}. Edit the requests to sound like your users, then run --validate-tasks.`);
    return EXIT_OK;
  }
  if (opts.validateTasks) {
    try {
      const file = parseScenarios(await readFile(opts.validateTasks, "utf8"), opts.validateTasks);
      const problems = checkAgainstSpec(file, input, opts.validateTasks);
      if (problems.length) throw new ScenarioError(problems);
      console.log(`${opts.validateTasks}: ${file.scenarios.length} ${file.scenarios.length === 1 ? "scenario" : "scenarios"}, all valid against the spec.`);
      return EXIT_OK;
    } catch (err) {
      if (err instanceof ScenarioError) {
        for (const p of err.problems) console.error(p);
        return EXIT_ERROR;
      }
      console.error(`muse-ready: ${(err as Error).message}`);
      return EXIT_ERROR;
    }
  }

  let simulation: Report["simulation"];
  if (opts.simulate) {
    try {
      if (opts.format === "terminal") console.error("Simulating scenarios (tool calls are answered from the spec; your API is not called)…");
      simulation = await runSimulation(input, config, {
        tasksFile: typeof opts.simulate === "string" ? opts.simulate : undefined,
        model: opts.model,
        baseUrl: opts.modelBaseUrl,
        runs: opts.runs,
      });
    } catch (err) {
      if (err instanceof SimulationSetupError) {
        console.error(`muse-ready: ${err.message}`);
        return EXIT_ERROR;
      }
      throw err;
    }
  }
  const report = await runRules(input, BUILTIN_RULES, config, probe, simulation);
  const json = () => JSON.stringify(report, null, 2) + "\n";
  const sarif = () => JSON.stringify(renderSarif(report), null, 2) + "\n";

  const writes: Promise<void>[] = [];
  if (opts.json) writes.push(writeFile(opts.json, json()));
  if (opts.md) writes.push(writeFile(opts.md, renderMarkdown(report)));
  if (opts.sarif) writes.push(writeFile(opts.sarif, sarif()));
  if (opts.badge) writes.push(writeFile(opts.badge, JSON.stringify(renderBadge(report), null, 2) + "\n"));
  await Promise.all(writes);

  switch (opts.format) {
    case "json":
      process.stdout.write(json());
      break;
    case "md":
      process.stdout.write(renderMarkdown(report));
      break;
    case "sarif":
      process.stdout.write(sarif());
      break;
    default:
      console.log(renderTerminal(report, { color: opts.color === false ? false : undefined, verbose: opts.verbose }));
  }

  const minPass = config.simulate?.minPassRate;
  if (simulation && minPass !== undefined && simulation.passRate < minPass) {
    if (opts.format === "terminal") console.error(`Scenario pass rate ${simulation.passRate}% is below simulate.minPassRate ${minPass}%.`);
    return EXIT_FAILED;
  }
  const failUnder: number | undefined = opts.failUnder ?? config.failUnder;
  if (!report.gate.passed) return EXIT_FAILED;
  if (failUnder !== undefined && report.score.overall < failUnder) {
    if (opts.format === "terminal") console.error(`Score ${report.score.overall} is below --fail-under ${failUnder}.`);
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`muse-ready: unexpected error: ${(err as Error).stack ?? err}`);
    process.exitCode = EXIT_ERROR;
  },
);
