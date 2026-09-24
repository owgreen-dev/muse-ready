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
