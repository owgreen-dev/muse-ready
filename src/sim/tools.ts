// Turns spec operations into model tool definitions, and answers tool calls from the spec's own examples.
import { SAFE_METHODS, operations, successSchema } from "../core/openapi.js";
import type { LoadedInput } from "../core/types.js";

export interface ToolDef {
  /** Name the model sees (a-z, 0-9, _ and -, max 64). */
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Operation label used by the grader: "GET /tasks" or an MCP tool name. */
  label: string;
  write: boolean;
  /** Mock answer for this tool, built from the spec's examples. */
  mock: () => unknown;
}

const MAX_DESCRIPTION = 1024;
const MAX_DEPTH = 6;

/** A JSON-safe copy of a schema: drops cycles and depth, keeps what models understand. */
export function cleanSchema(schema: unknown, depth = 0, seen = new Set<unknown>()): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || depth > MAX_DEPTH || seen.has(schema)) return {};
  seen.add(schema);
  const s = schema as Record<string, any>;
  const out: Record<string, unknown> = {};
  for (const key of ["type", "description", "enum", "format", "default", "minimum", "maximum", "minLength", "maxLength", "pattern", "required"]) {
    if (s[key] !== undefined) out[key] = s[key];
  }
  if (Array.isArray(out.type)) out.type = (out.type as string[]).find((t) => t !== "null") ?? "string";
  if (s.properties && typeof s.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, cleanSchema(v, depth + 1, seen)]));
    out.type ??= "object";
  }
  if (s.items) out.items = cleanSchema(s.items, depth + 1, seen);
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    if (Array.isArray(s[key]) && s[key].length) Object.assign(out, cleanSchema(s[key][0], depth + 1, seen));
  }
  seen.delete(schema);
  return out;
}

function toolName(raw: string, taken: Set<string>): string {
  let name = raw.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "operation";
  let n = 2;
  while (taken.has(name)) name = `${name.slice(0, 60)}_${n++}`;
  taken.add(name);
  return name;
}

/** Example value for a schema, preferring the spec's own examples. */
export function exampleFor(schema: any, depth = 0, seen = new Set<unknown>()): unknown {
  if (!schema || typeof schema !== "object" || depth > 4 || seen.has(schema)) return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  seen.add(schema);
  const pick = schema.allOf?.[0] ?? schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (pick) return exampleFor(pick, depth + 1, seen);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
  if (type === "array" || schema.items) return [exampleFor(schema.items, depth + 1, seen)];
  if (type === "object" || schema.properties) {
    return Object.fromEntries(Object.entries<any>(schema.properties ?? {}).map(([k, v]) => [k, exampleFor(v, depth + 1, seen)]));
  }
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (schema.format === "date-time") return "2026-09-24T12:00:00Z";
  return "example";
}

function responseExample(op: any): { status: number; body: unknown } {
  const responses = op?.responses ?? {};
  const code = Object.keys(responses).find((c) => /^2\d\d$/.test(c)) ?? "200";
  const r = responses[code] ?? {};
  const media = r.content?.["application/json"] ?? Object.values<any>(r.content ?? {})[0];
  if (media?.example !== undefined) return { status: Number(code), body: media.example };
  if (media?.examples && typeof media.examples === "object") {
    const first = Object.values<any>(media.examples)[0];
    if (first?.value !== undefined) return { status: Number(code), body: first.value };
  }
  const schema = successSchema(op) ?? media?.schema ?? r.schema;
  return { status: Number(code), body: schema ? exampleFor(schema) : null };
}

export function buildTools(input: LoadedInput): ToolDef[] {
  const taken = new Set<string>();
  if (input.kind === "mcp") {
    return (input.tools ?? [])
      .filter((t) => typeof t?.name === "string")
      .map((t) => ({
        name: toolName(String(t.name), taken),
        description: String(t.description ?? "").slice(0, MAX_DESCRIPTION),
        parameters: { type: "object", ...cleanSchema(t.inputSchema) },
        label: String(t.name),
        write: t.annotations?.readOnlyHint !== true,
        mock: () => ({ content: [{ type: "text", text: `${String(t.name)} completed (simulated).` }] }),
      }));
  }
  return operations(input.resolved).map((o) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of [...(o.pathItem.parameters ?? []), ...(o.op.parameters ?? [])]) {
      if (!p || typeof p.name !== "string" || p.in === "header" || p.in === "cookie") continue;
      properties[p.name] = { ...cleanSchema(p.schema ?? { type: p.type ?? "string" }), ...(p.description ? { description: p.description } : {}) };
      if (p.required || p.in === "path") required.push(p.name);
    }
    const body = o.op.requestBody?.content?.["application/json"]?.schema;
    if (body) {
      const cleaned = cleanSchema(body);
      for (const [k, v] of Object.entries((cleaned.properties as Record<string, unknown>) ?? {})) properties[properties[k] ? `body_${k}` : k] = v;
      for (const r of (cleaned.required as string[]) ?? []) required.push(r);
    }
    const description = [o.op.summary, o.op.description].filter((x) => typeof x === "string" && x.trim()).join(". ").slice(0, MAX_DESCRIPTION);
    return {
      name: toolName(typeof o.op.operationId === "string" ? o.op.operationId : `${o.method}_${o.path}`, taken),
      description: description || o.label,
      parameters: { type: "object", properties, ...(required.length ? { required: [...new Set(required)] } : {}) },
      label: o.label,
      write: !SAFE_METHODS.has(o.method),
      mock: () => (o.method === "delete" && !o.op.responses?.["200"] ? { status: 204, body: null } : responseExample(o.op)),
    };
  });
}
