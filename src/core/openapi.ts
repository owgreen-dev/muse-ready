import type { Pointer } from "./types.js";

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export const SAFE_METHODS: ReadonlySet<string> = new Set(["get", "head", "options"]);

export interface Operation {
  path: string;
  method: HttpMethod;
  op: any;
  pathItem: any;
  pointer: Pointer;
  /** "GET /items" */
  label: string;
}

export function operations(doc: any): Operation[] {
  const out: Operation[] = [];
  const paths = doc?.paths;
  if (!paths || typeof paths !== "object") return out;
  for (const [path, item] of Object.entries<any>(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op && typeof op === "object") {
        out.push({ path, method, op, pathItem: item, pointer: ["paths", path, method], label: `${method.toUpperCase()} ${path}` });
      }
    }
  }
  return out;
}

export function isSwagger2(doc: any): boolean {
  return typeof doc?.swagger === "string";
}

export interface SecurityScheme {
  name: string;
  scheme: any;
  pointer: Pointer;
}

export function securitySchemes(doc: any): SecurityScheme[] {
  const container = isSwagger2(doc) ? doc?.securityDefinitions : doc?.components?.securitySchemes;
  const base: Pointer = isSwagger2(doc) ? ["securityDefinitions"] : ["components", "securitySchemes"];
  if (!container || typeof container !== "object") return [];
  return Object.entries<any>(container)
    .filter(([, s]) => s && typeof s === "object")
    .map(([name, scheme]) => ({ name, scheme, pointer: [...base, name] }));
}

/** A credential the user can paste once: a bearer token, basic auth, or an API key in a header. */
export function isStaticHeaderScheme(s: any): boolean {
  const type = String(s?.type ?? "").toLowerCase();
  if (type === "apikey") return String(s.in ?? "").toLowerCase() === "header";
  if (type === "http") return ["bearer", "basic"].includes(String(s.scheme ?? "").toLowerCase());
  if (type === "basic") return true; // Swagger 2
  return false;
}

export function isOAuthScheme(s: any): boolean {
  const type = String(s?.type ?? "").toLowerCase();
  return type === "oauth2" || type === "openidconnect";
}

export interface ServerUrl {
  url: string;
  pointer: Pointer;
}

export function serverUrls(doc: any): ServerUrl[] {
  if (isSwagger2(doc)) {
    if (!doc.host) return [];
    const schemes: string[] = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes : ["https"];
    return schemes.map((scheme) => ({ url: `${scheme}://${doc.host}${doc.basePath ?? ""}`, pointer: ["host"] }));
  }
  if (!Array.isArray(doc?.servers)) return [];
  return doc.servers
    .map((s: any, i: number) => {
      if (!s || typeof s.url !== "string") return undefined;
      let url: string = s.url;
      for (const [name, v] of Object.entries<any>(s.variables ?? {})) {
        url = url.split(`{${name}}`).join(String(v?.default ?? ""));
      }
      return { url, pointer: ["servers", i, "url"] };
    })
    .filter(Boolean) as ServerUrl[];
}

export interface TextField {
  key: string;
  text: string;
  pointer: Pointer;
}

const TEXT_KEYS = new Set(["description", "summary", "title", "x-description"]);

/** Every human- or model-readable string in the document: descriptions, summaries, titles. */
export function textFields(doc: unknown): TextField[] {
  const out: TextField[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown, pointer: Pointer) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, [...pointer, i]));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && TEXT_KEYS.has(k)) out.push({ key: k, text: v, pointer: [...pointer, k] });
      else walk(v, [...pointer, k]);
    }
  };
  walk(doc, []);
  return out;
}

/** Parameter names and top-level JSON request-body property names for an operation. */
export function inputNames(o: Operation): string[] {
  const names: string[] = [];
  const params = [...(o.pathItem.parameters ?? []), ...(o.op.parameters ?? [])];
  for (const p of params) if (p && typeof p.name === "string") names.push(p.name);
  const content = o.op.requestBody?.content;
  if (content && typeof content === "object") {
    for (const media of Object.values<any>(content)) collectProps(media?.schema, names, 0);
  }
  // Swagger 2 body parameter
  for (const p of params) if (p?.in === "body") collectProps(p.schema, names, 0);
  return names;
}

function collectProps(schema: any, names: string[], depth: number) {
  if (!schema || typeof schema !== "object" || depth > 3) return;
  if (schema.properties && typeof schema.properties === "object") names.push(...Object.keys(schema.properties));
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    if (Array.isArray(schema[key])) for (const s of schema[key]) collectProps(s, names, depth + 1);
  }
}

export function hasRequestBody(o: Operation): boolean {
  if (o.op.requestBody) return true;
  const params = [...(o.pathItem.parameters ?? []), ...(o.op.parameters ?? [])];
  return params.some((p: any) => p?.in === "body" || p?.in === "formData");
}

/** Words an operation is known by: operationId, summary and path, split into lowercase tokens. */
export function operationWords(o: Operation): string[] {
  const text = [o.op.operationId, o.op.summary, o.path].filter((s) => typeof s === "string").join(" ");
  return splitWords(text);
}

export function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
