import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { validate, dereference } from "@readme/openapi-parser";
import type { InputKind, LoadedInput, McpTool } from "./types.js";

export class LoadError extends Error {}

const FETCH_TIMEOUT_MS = 15_000;

export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

async function readSource(source: string): Promise<string> {
  if (!isUrl(source)) {
    try {
      return await readFile(source, "utf8");
    } catch (err) {
      throw new LoadError(`Cannot read ${source}: ${(err as Error).message}`);
    }
  }
  let res: Response;
  try {
    res = await fetch(source, {
      headers: { accept: "application/json, application/yaml, text/yaml, */*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LoadError(`Cannot fetch ${source}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new LoadError(`Fetching ${source} returned HTTP ${res.status}`);
  return res.text();
}

function parseText(raw: string, source: string): unknown {
  try {
    // YAML is a superset of JSON, so one parser covers both.
    return parseYaml(raw, { maxAliasCount: 1000 });
  } catch (err) {
    throw new LoadError(`${source} is not valid JSON or YAML: ${(err as Error).message}`);
  }
}

/** Accepts a tools/list result, a JSON-RPC response wrapping one, or a bare tool array. */
export function extractMcpTools(doc: unknown): McpTool[] | undefined {
  if (Array.isArray(doc)) return doc as McpTool[];
  if (doc && typeof doc === "object") {
    const d = doc as Record<string, any>;
    if (Array.isArray(d.tools)) return d.tools;
    if (d.result && Array.isArray(d.result.tools)) return d.result.tools;
  }
  return undefined;
}

export function detectKind(doc: unknown): InputKind | undefined {
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    const d = doc as Record<string, unknown>;
    if (typeof d.openapi === "string" || typeof d.swagger === "string") return "openapi";
  }
  if (extractMcpTools(doc)) return "mcp";
  return undefined;
}

function firstLine(message: string): string {
  return message.split("\n")[0]!.trim();
}

export async function loadInput(source: string, forceKind?: InputKind): Promise<LoadedInput> {
  const url = isUrl(source);
  const raw = await readSource(source);
  const doc = parseText(raw, source);
  const kind = forceKind ?? detectKind(doc);
  if (!kind) {
    throw new LoadError(
      `${source} is neither an OpenAPI document (no "openapi"/"swagger" field) nor an MCP tool list (no "tools" array).`,
    );
  }

  const input: LoadedInput = { source, isUrl: url, kind, raw, doc };

  if (kind === "mcp") {
    input.tools = extractMcpTools(doc) ?? [];
    return input;
  }

  // Local files are validated from their path so relative external $refs resolve. URL specs reuse the
  // document already fetched: the parser's own HTTP resolver fails on plain YAML/JSON responses, so
  // external $refs in a remote spec are not followed.
  const location = () => (url ? structuredClone(doc as object) : resolvePath(source));
  try {
    const result = await validate(location() as any);
    input.validation = {
      valid: result.valid,
      errors: result.valid ? [] : result.errors.map((e) => firstLine(e.message)),
      warnings: result.warnings.map((w) => firstLine(w.message)),
      specification: result.specification ?? undefined,
    };
  } catch (err) {
    input.validation = { valid: false, errors: [firstLine((err as Error).message)], warnings: [] };
  }
  try {
    input.resolved = await dereference(location() as any);
  } catch {
    input.resolved = doc;
  }
  return input;
}
