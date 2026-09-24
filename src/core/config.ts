import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ConnectorMeta, Severity } from "./types.js";

export type RuleSetting = "off" | Severity;

export interface Config {
  /** Target platform: muse (default), claude, openai-apps, gemini or mcp. */
  profile?: string;
  /** Turn a rule off or change its severity, keyed by rule ID. */
  rules?: Record<string, RuleSetting>;
  connector?: ConnectorMeta;
  /** Exit non-zero when the overall score is below this. */
  failUnder?: number;
  simulate?: {
    /** Model ID, e.g. muse-spark-1.3. */
    model?: string;
    /** OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1. */
    baseUrl?: string;
    /** Scenario file. Default: muse-ready.tasks.yaml */
    tasks?: string;
    /** Runs per scenario. Default 3. */
    runs?: number;
    /** Exit 1 when the pass rate (0-100) is below this. */
    minPassRate?: number;
  };
  probe?: {
    /** Header that carries MUSE_READY_TOKEN, e.g. "X-API-Key". Default: from the spec, else Authorization: Bearer. */
    authHeader?: string;
  };
}

export const CONFIG_FILES = [
  "muse-ready.config.json",
  "muse-ready.config.yaml",
  "muse-ready.config.yml",
];

const SETTINGS = new Set(["off", "critical", "high", "medium", "low"]);

export function validateConfig(cfg: unknown, where: string): Config {
  if (cfg == null) return {};
  if (typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(`${where}: config must be an object`);
  const c = cfg as Config;
  for (const [id, setting] of Object.entries(c.rules ?? {})) {
    if (!SETTINGS.has(setting)) {
      throw new Error(`${where}: rules.${id} must be one of off, critical, high, medium, low`);
    }
  }
  if (c.profile !== undefined && typeof c.profile !== "string") throw new Error(`${where}: profile must be a string`);
  if (c.failUnder !== undefined && (typeof c.failUnder !== "number" || c.failUnder < 0 || c.failUnder > 100)) {
    throw new Error(`${where}: failUnder must be a number from 0 to 100`);
  }
  const sim = c.simulate;
  if (sim !== undefined) {
    if (typeof sim !== "object" || Array.isArray(sim)) throw new Error(`${where}: simulate must be an object`);
    if (sim.runs !== undefined && !(Number.isInteger(sim.runs) && sim.runs >= 1 && sim.runs <= 20)) throw new Error(`${where}: simulate.runs must be 1-20`);
    if (sim.minPassRate !== undefined && !(typeof sim.minPassRate === "number" && sim.minPassRate >= 0 && sim.minPassRate <= 100)) throw new Error(`${where}: simulate.minPassRate must be 0-100`);
    if ((sim as Record<string, unknown>).apiKey !== undefined || (sim as Record<string, unknown>).key !== undefined) {
      throw new Error(`${where}: never put a model key in the config file. Use the MUSE_READY_LLM_KEY environment variable.`);
    }
  }
  if (c.probe?.authHeader !== undefined && (typeof c.probe.authHeader !== "string" || !/^[A-Za-z0-9-]+$/.test(c.probe.authHeader))) {
    throw new Error(`${where}: probe.authHeader must be a header name`);
  }
  if ((c as Record<string, unknown>).token !== undefined || (c.probe as Record<string, unknown> | undefined)?.token !== undefined) {
    throw new Error(`${where}: never put a token in the config file. Use the MUSE_READY_TOKEN environment variable.`);
  }
  return c;
}

export async function loadConfig(explicitPath?: string, cwd = process.cwd()): Promise<Config> {
  let path = explicitPath;
  if (!path) {
    for (const name of CONFIG_FILES) {
      const candidate = join(cwd, name);
      try {
        await access(candidate);
        path = candidate;
        break;
      } catch {
        /* not present */
      }
    }
  }
  if (!path) return {};
  const text = await readFile(path, "utf8");
  return validateConfig(parseYaml(text), path);
}
