import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../../package.json") as { name: string; version: string };

export const TOOL_NAME = pkg.name;
export const TOOL_VERSION = pkg.version;
/**
 * Date the Muse-specific assumptions in the ruleset were last checked against public sources.
 * Muse changes weekly: bump this whenever a rule is revised against new evidence.
 */
export const RULESET_DATE = "2026-09-23";
