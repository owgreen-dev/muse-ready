#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import { loadConfig } from "../core/config.js";
import { runRules } from "../core/engine.js";
import { LoadError, loadInput } from "../core/load.js";
import { RULESET_DATE, TOOL_VERSION } from "../core/version.js";
import { renderBadge } from "../report/badge.js";
import { renderMarkdown } from "../report/markdown.js";
import { renderSarif } from "../report/sarif.js";
import { renderTerminal } from "../report/terminal.js";
import { BUILTIN_RULES } from "../rules/index.js";

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
  .addOption(new Option("--kind <kind>", "input type, if auto-detection guesses wrong").choices(["openapi", "mcp"]))
  .option("-c, --config <file>", "config file (default: muse-ready.config.{json,yaml,yml} in the current directory)")
  .option("--fail-under <score>", "exit 1 when the overall score is below this", score)
  .option("--no-color", "disable colors")
  .option("-v, --verbose", "also list rules that do not apply")
  .option("--list-rules", "print the rule catalog and exit")
  .addHelpText(
    "after",
    `
Exit codes: 0 ready, 1 blocking failure or score below --fail-under, 2 could not run.
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

  const report = await runRules(input, BUILTIN_RULES, config);
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
