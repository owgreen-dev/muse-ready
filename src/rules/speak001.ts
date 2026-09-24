import type { Finding, Rule } from "../core/types.js";
import { operations, successSchema } from "../core/openapi.js";
import { aggregate, plural } from "./util.js";

/** Field names an agent can read aloud as a one-line answer. */
export const SPEAKABLE_FIELDS = ["summary", "title", "name", "label", "displayName", "display_name", "username", "fullName", "full_name", "firstName", "first_name", "headline", "text", "message", "description", "subject", "status"];
/** Provisional: roughly one spoken sentence. Muse publishes no limit. */
export const MAX_SPOKEN_CHARS = 200;

function objectSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return undefined;
  if (schema.type === "array" || schema.items) return objectSchema(schema.items);
  if (schema.properties) {
    // A wrapper like { items: [...] } or { data: {...} } -> look inside
    for (const key of ["items", "data", "results", "records", "entries"]) {
      const inner = schema.properties[key];
      if (inner && (inner.items || inner.properties)) return objectSchema(inner);
    }
    return schema;
  }
  for (const key of ["allOf", "oneOf", "anyOf"]) if (Array.isArray(schema[key])) return objectSchema(schema[key][0]);
  return undefined;
}

export function hasSpeakableProperty(schema: any): boolean | undefined {
  const obj = objectSchema(schema);
  if (!obj?.properties) return undefined;
  return Object.keys(obj.properties).some((k) => SPEAKABLE_FIELDS.includes(k));
}

/** Finds a short string in the first object of a JSON body (or the first item of a list). */
export function speakableValue(body: unknown): string | undefined | null {
  let node: any = body;
  if (Array.isArray(node)) node = node[0];
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const key of ["items", "data", "results", "records", "entries"]) {
      if (Array.isArray(node[key])) {
        node = node[key][0];
        break;
      }
    }
  }
  if (!node || typeof node !== "object") return typeof node === "string" ? (node.length <= MAX_SPOKEN_CHARS ? node : null) : undefined;
  const strings = Object.entries(node).filter(([, v]) => typeof v === "string") as [string, string][];
  if (strings.length === 0) return null;
  const preferred = strings.find(([k, v]) => SPEAKABLE_FIELDS.includes(k) && v.length > 0 && v.length <= MAX_SPOKEN_CHARS);
  return preferred ? preferred[1] : null;
}

export const SPEAK001: Rule = {
  id: "SPEAK001",
  title: "Responses include something short enough to say aloud",
  category: "description",
  severity: "medium",
  subscores: ["custom"],
  appliesTo: ["openapi"],
  rationale:
    "Muse answers by voice, on Ray-Ban glasses and on the Charm device (Meta Connect, 23 Sep 2026). A result needs a short name, title or summary the agent can speak, not only IDs and nested data. The 200-character limit is provisional; Meta publishes none. The live part runs with --probe.",
  run(ctx) {
    const fails: Finding[] = [];
    const warns: Finding[] = [];
    let checked = 0;

    for (const o of operations(ctx.input.resolved)) {
      if (o.method !== "get") continue;
      const has = hasSpeakableProperty(successSchema(o.op));
      if (has === undefined) continue;
      checked++;
      if (!has) warns.push({ message: `${o.label} returns objects with no summary, title or name field to read aloud`, pointer: [...o.pointer, "responses"] });
    }

    for (const r of ctx.probe?.requests ?? []) {
      if (!r.bodySample || r.status === undefined || r.status >= 300 || !r.operation) continue;
      let body: unknown;
      try {
        body = JSON.parse(r.bodySample);
      } catch {
        continue; // truncated or not JSON
      }
      checked++;
      if (speakableValue(body) === null) warns.push({ message: `${r.operation} (live) returned no field under ${MAX_SPOKEN_CHARS} characters that could be read aloud` });
    }

    if (checked === 0) return { status: "not-applicable", message: "No documented JSON response objects to check." };
    const unique = [...new Map(warns.map((f) => [f.message, f])).values()];
    return aggregate(fails, unique, {
      pass: `${plural(checked, "response")} checked; each has a short field an agent can say aloud.`,
      fail: "",
      warn: `${plural(unique.length, "response")} would be hard to answer by voice.`,
    });
  },
};
