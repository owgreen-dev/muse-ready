// MCP JSON-RPC checks for --probe-mcp: tools/list without a session (stateless), and tools/list repeated in a
// session (stability). Only initialize, notifications/initialized and tools/list are ever sent; see postMcpJsonRpc.
import { createHash } from "node:crypto";
import type { McpListing, McpProbe } from "../core/types.js";
import { ProbeError, postMcpJsonRpc, type SafeRequestOptions } from "./http.js";

export const PROTOCOL_VERSION = "2026-07-28";
const MAX_PAGES = 5;

type RequestOptions = Pick<SafeRequestOptions, "allowPrivateNetwork" | "allowInsecureHttp" | "addressPolicy" | "resolver" | "ca" | "credentialHeaders">;

/** Parses a JSON-RPC response sent as plain JSON or as a server-sent event stream. */
export function parseJsonRpc(body: string, id: number): any {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.find((m) => m?.id === id) : parsed;
  }
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const msg = JSON.parse(line.slice(5).trim());
      if (msg?.id === id) return msg;
    } catch {
      /* not JSON: skip */
    }
  }
  return undefined;
}

export function fingerprint(tools: unknown[]): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  const shape = tools.map((t: any) => ({ name: t?.name, description: t?.description, inputSchema: t?.inputSchema }));
  return createHash("sha256").update(JSON.stringify(canonical(shape))).digest("hex").slice(0, 16);
}

async function listTools(url: string, headers: Record<string, string>, request: RequestOptions, nextId: () => number): Promise<McpListing> {
  const tools: unknown[] = [];
  let cursor: string | undefined;
  let status: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const id = nextId();
    try {
      const r = await postMcpJsonRpc(url, { jsonrpc: "2.0", id, method: "tools/list", ...(cursor ? { params: { cursor } } : {}) }, { ...request, headers, timeoutMs: 15_000, maxBytes: 1024 * 1024 });
      status = r.status;
      if (r.status < 200 || r.status >= 300) return { status, error: `HTTP ${r.status}` };
      const msg = parseJsonRpc(r.body, id);
      if (!msg) return { status, error: "no JSON-RPC response" };
      if (msg.error) return { status, error: `JSON-RPC error ${msg.error.code ?? ""}: ${String(msg.error.message ?? "").slice(0, 120)}` };
      const pageTools = msg.result?.tools;
      if (!Array.isArray(pageTools)) return { status, error: "result has no tools array" };
      tools.push(...pageTools);
      cursor = typeof msg.result?.nextCursor === "string" && msg.result.nextCursor ? msg.result.nextCursor : undefined;
      if (!cursor) break;
    } catch (err) {
      return { status, error: err instanceof ProbeError ? err.message : "request failed" };
    }
  }
  return { status, tools: tools.map((t: any) => String(t?.name)), fingerprint: fingerprint(tools) };
}

export async function probeMcp(url: string, authHeaders: Record<string, string> | undefined, request: RequestOptions): Promise<McpProbe> {
  let id = 0;
  const nextId = () => ++id;
  const auth = authHeaders ?? {};
  const req: RequestOptions = { ...request, credentialHeaders: Object.keys(auth) };

  // 1. Stateless: no initialize, no session id.
  const stateless = await listTools(url, { ...auth, "mcp-protocol-version": PROTOCOL_VERSION }, req, nextId);

  // 2. Session: initialize, notify, then list twice.
  const session: McpProbe["session"] = { initialized: false, usedSessionId: false };
  try {
    const initId = nextId();
    const init = await postMcpJsonRpc(
      url,
      { jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "muse-ready", version: "probe" } } },
      { ...req, headers: auth, timeoutMs: 15_000, maxBytes: 256 * 1024 },
    );
    const msg = init.status >= 200 && init.status < 300 ? parseJsonRpc(init.body, initId) : undefined;
    if (!msg?.result) {
      session.error = init.status >= 300 ? `initialize returned HTTP ${init.status}` : msg?.error ? `initialize error: ${String(msg.error.message ?? "").slice(0, 120)}` : "initialize returned no result";
      return { stateless, session };
    }
    session.initialized = true;
    session.protocolVersion = typeof msg.result.protocolVersion === "string" ? msg.result.protocolVersion : undefined;
    const sid = init.headers["mcp-session-id"];
    const headers: Record<string, string> = {
      ...auth,
      "mcp-protocol-version": session.protocolVersion ?? PROTOCOL_VERSION,
      ...(typeof sid === "string" && sid ? { "mcp-session-id": sid } : {}),
    };
    session.usedSessionId = typeof sid === "string" && !!sid;
    await postMcpJsonRpc(url, { jsonrpc: "2.0", method: "notifications/initialized" }, { ...req, headers, timeoutMs: 15_000, maxBytes: 64 * 1024 }).catch(() => undefined);
    session.first = await listTools(url, headers, req, nextId);
    session.second = await listTools(url, headers, req, nextId);
  } catch (err) {
    session.error = err instanceof ProbeError ? err.message : "request failed";
  }
  return { stateless, session };
}
