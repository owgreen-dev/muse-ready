import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isSecured, operations, returnsList, serverUrls, successSchema, type Operation } from "../core/openapi.js";
import type { ConnectorMeta, LoadedInput, ProbeRequest, ProbeResult } from "../core/types.js";
import { WRITE_VERBS, firstWord } from "../rules/util.js";
import { isBlockedAddress } from "./address.js";
import { imageSize } from "./image.js";
import { discoverOAuth } from "./oauth.js";
import { probeMcp } from "./mcp.js";
import { isOAuthScheme, securitySchemes } from "../core/openapi.js";
import { ProbeError, redactUrl, safeRequest, type SafeRequestOptions } from "./http.js";

export const MAX_OPERATIONS = 8;
export const LATENCY_SAMPLES = 5;
export const BODY_SAMPLE_BYTES = 4096;
/** Just over the PAGE002 fail threshold, so an oversize list is detected without downloading all of it. */
export const LIST_SAMPLE_CAP = 1024 * 1024 + 1;

export interface ProbeOptions {
  /** Also send MCP JSON-RPC initialize and tools/list POSTs to an MCP endpoint (--probe-mcp). */
  mcp?: boolean;
  /** Headers attached to authenticated requests (T-004). Never recorded. */
  authHeaders?: Record<string, string>;
  /** Passed through to safeRequest. Tests use these to reach local servers. */
  request?: Pick<SafeRequestOptions, "allowPrivateNetwork" | "allowInsecureHttp" | "addressPolicy" | "resolver" | "ca" | "timeoutMs">;
}

/** Base URL the probe targets, or undefined with a reason. */
export function probeTarget(input: LoadedInput, connector: ConnectorMeta): { url?: string; reason?: string } {
  if (input.kind === "mcp") {
    return connector.serverUrl ? { url: connector.serverUrl } : { reason: "Set connector.serverUrl to probe an MCP server." };
  }
  const [first] = serverUrls(input.resolved);
  if (!first) return { reason: "The document declares no servers." };
  try {
    return { url: new URL(first.url, input.isUrl ? input.source : undefined).toString() };
  } catch {
    return { reason: `Server URL "${first.url}" is relative. Run against the spec's public URL or make it absolute.` };
  }
}

function exampleValue(p: any): string | undefined {
  const candidates = [p?.example, p?.schema?.example, p?.schema?.default, p?.default, p?.["x-example"]];
  if (p?.examples && typeof p.examples === "object") {
    const first = Object.values<any>(p.examples)[0];
    candidates.push(first?.value);
  }
  const v = candidates.find((c) => c !== undefined && c !== null && typeof c !== "object");
  return v === undefined ? undefined : String(v);
}

/** GETs named like actions can still have side effects (e.g. GET /logout). The probe never calls them. */
const ACTION_WORDS = new Set([...WRITE_VERBS, "login", "logout", "signin", "signout", "sign", "log", "authorize", "oauth", "callback", "verify", "confirm", "activate", "redeem", "claim", "checkout"]);

export function looksLikeAction(o: Operation): string | undefined {
  for (const text of [o.op.operationId, o.op.summary, o.path.split("/").filter((s) => s && !s.startsWith("{")).pop()]) {
    const word = firstWord(text);
    if (word && ACTION_WORDS.has(word)) return word;
  }
  return undefined;
}

/** Builds a concrete URL for a GET operation, or explains why it cannot be called safely. */
export function buildRequest(base: string, o: Operation): { url?: string; reason?: string } {
  const params = [...(o.pathItem.parameters ?? []), ...(o.op.parameters ?? [])].filter((p: any) => p && typeof p.name === "string");
  let path = o.path;
  const query = new URLSearchParams();
  for (const p of params) {
    if (p.in === "path") {
      const v = exampleValue(p);
      if (v === undefined) return { reason: `path parameter "${p.name}" has no example or default` };
      path = path.split(`{${p.name}}`).join(encodeURIComponent(v));
    } else if (p.required) {
      const v = exampleValue(p);
      if (v === undefined) return { reason: `required ${p.in} parameter "${p.name}" has no example or default` };
      if (p.in === "query") query.set(p.name, v);
      else if (p.in !== "header") return { reason: `required ${p.in} parameter "${p.name}"` };
    }
  }
  if (o.op.requestBody) return { reason: "takes a request body" };
  const url = new URL(base.replace(/\/?$/, "/") + path.replace(/^\//, ""));
  for (const [k, v] of query) url.searchParams.set(k, v);
  return { url: url.toString() };
}

function pathOf(url: string): string {
  const u = new URL(redactUrl(url));
  return `${u.pathname}${u.search}`;
}

async function call(url: string, operation: string | undefined, headers: Record<string, string> | undefined, opts: ProbeOptions, maxBytes: number): Promise<ProbeRequest> {
  const record: ProbeRequest = { method: "GET", path: pathOf(url), operation, authenticated: !!headers && Object.keys(headers).length > 0 };
  try {
    const r = await safeRequest(url, {
      ...opts.request,
      timeoutMs: opts.request?.timeoutMs ?? 30_000,
      maxBytes,
      headers,
      // Whatever header carries the credential is stripped on any cross-origin redirect.
      credentialHeaders: Object.keys(opts.authHeaders ?? {}),
    });
    Object.assign(record, { status: r.status, ms: r.ms, bytes: r.bytes, truncated: r.truncated, bodySample: r.body.slice(0, BODY_SAMPLE_BYTES) });
    const challenge = r.headers["www-authenticate"];
    if (r.status === 401 && challenge) record.wwwAuthenticate = Array.isArray(challenge) ? challenge.join(", ") : challenge;
  } catch (err) {
    const e = err instanceof ProbeError ? err : new ProbeError("network", "request failed");
    record.error = { code: e.code, message: e.message };
  }
  return record;
}

async function fetchIcon(url: string, opts: ProbeOptions): Promise<NonNullable<ProbeResult["icon"]>> {
  const shown = redactUrl(url);
  try {
    // No credentials: the icon is public listing material.
    const r = await safeRequest(url, { ...opts.request, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, binary: true });
    const size = r.buffer ? imageSize(r.buffer) : undefined;
    return { url: shown, status: r.status, contentType: String(r.headers["content-type"] ?? ""), ...(size ?? {}) };
  } catch (err) {
    return { url: shown, error: err instanceof ProbeError ? err.message : "request failed" };
  }
}

/** Runs the live probe. Sends only GET/HEAD requests, never throws, and records every request. */
export async function runProbe(input: LoadedInput, connector: ConnectorMeta, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const target = probeTarget(input, connector);
  if (!target.url) return { enabled: true, target: "", requests: [], skipped: [], error: target.reason ?? "No probe target." };
  const result: ProbeResult = { enabled: true, target: redactUrl(target.url), requests: [], skipped: [] };

  // DNS, reported separately so NET002 can explain a failure precisely.
  const host = new URL(target.url).hostname.replace(/^\[|\]$/g, "");
  try {
    const answers = isIP(host) ? [{ address: host }] : await (opts.request?.resolver ?? ((h: string) => dnsLookup(h, { all: true })))(host);
    const addresses = answers.map((a) => a.address);
    const policy = opts.request?.addressPolicy ?? ((ip: string) => opts.request?.allowPrivateNetwork === true || !isBlockedAddress(ip));
    result.dns = { addresses, blocked: addresses.filter((a) => !policy(a)) };
  } catch {
    result.dns = { addresses: [], blocked: [], error: `${host} does not resolve.` };
  }
  if (connector.iconUrl) result.icon = await fetchIcon(connector.iconUrl, opts);
  if (!result.dns.addresses.length || result.dns.blocked.length) return result;

  if (input.kind === "mcp") {
    const r = await call(target.url, undefined, undefined, opts, BODY_SAMPLE_BYTES);
    result.requests.push(r);
    if (opts.mcp) result.mcp = await probeMcp(target.url, opts.authHeaders, opts.request ?? {});
  } else {
    const candidates: { o: Operation; url: string }[] = [];
    for (const o of operations(input.resolved)) {
      if (o.method !== "get") continue;
      const action = looksLikeAction(o);
      if (action) {
        result.skipped.push({ operation: o.label, reason: `named like an action ("${action}"), so it may have side effects` });
        continue;
      }
      const built = buildRequest(target.url, o);
      if (!built.url) result.skipped.push({ operation: o.label, reason: built.reason! });
      else if (candidates.length < MAX_OPERATIONS) candidates.push({ o, url: built.url });
      else result.skipped.push({ operation: o.label, reason: `probe limit of ${MAX_OPERATIONS} operations reached` });
    }
    if (candidates.length === 0) {
      // Nothing callable: still measure reachability, TLS and latency against the base URL.
      result.requests.push(await call(target.url, undefined, undefined, opts, BODY_SAMPLE_BYTES));
    }
    for (const { o, url } of candidates) {
      const isList = returnsList(successSchema(o.op));
      const auth = isSecured(input.resolved, o.op) ? opts.authHeaders : undefined;
      result.requests.push(await call(url, o.label, auth, opts, isList ? LIST_SAMPLE_CAP : BODY_SAMPLE_BYTES * 16));
      // With credentials, also check that the operation rejects an unauthenticated call (ERR002).
      if (auth) result.requests.push(await call(url, o.label, undefined, opts, BODY_SAMPLE_BYTES));
    }
    // Top up latency samples by repeating the first successful call.
    const first = candidates[0];
    while (first && result.requests.filter((r) => r.ms !== undefined).length < LATENCY_SAMPLES && result.requests.length < LATENCY_SAMPLES + MAX_OPERATIONS) {
      const auth = isSecured(input.resolved, first.o.op) ? opts.authHeaders : undefined;
      const r = await call(first.url, first.o.label, auth, opts, BODY_SAMPLE_BYTES);
      result.requests.push(r);
      if (r.error) break;
    }
  }

  // OAuth discovery: when the spec or config says OAuth, or (for MCP) when auth is unknown.
  const declaredOAuth =
    input.kind === "openapi" ? securitySchemes(input.resolved).some((s) => isOAuthScheme(s.scheme)) : connector.auth === "oauth";
  const unknownMcp = input.kind === "mcp" && !connector.auth;
  if (declaredOAuth || unknownMcp) {
    result.oauth = await discoverOAuth(target.url, declaredOAuth ? "declared" : "attempted", opts.request ?? {});
  }

  const tlsError = result.requests.map((r) => r.error).find((e) => e && /TLS verification failed/.test(e.message));
  if (target.url.startsWith("https:")) result.tls = tlsError ? { verified: false, error: tlsError.message } : { verified: result.requests.some((r) => r.status !== undefined) };
  return result;
}
